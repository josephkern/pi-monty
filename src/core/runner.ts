import {
  Monty,
  MontyComplete,
  MontyNameLookup,
  MontyRuntimeError,
  MontySnapshot,
  MontySyntaxError,
  MontyTypingError,
} from '@pydantic/monty'
import type { ResourceLimits } from '@pydantic/monty'
import { probeTypeCheckerGaps } from './capabilities.js'
import { ToolRegistry } from './registry.js'
import { HostToolError } from './types.js'
import type { HostTool, RunLimits, RunOptions, RunResult, ToolCallTrace } from './types.js'

const DEFAULT_LIMITS: Required<Pick<RunLimits, 'maxDurationSecs' | 'maxMemory'>> = {
  maxDurationSecs: 5,
  maxMemory: 64 * 1024 * 1024,
}

const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024

const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
  'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
])

// probed once per process; names land verbatim in the typecheck prefix
let typeCheckerGaps: string[] | null = null

/** Monty names calls through a resolved value after the JS function's `name`. */
function namedPlaceholder(name: string): () => undefined {
  const fn = () => undefined
  Object.defineProperty(fn, 'name', { value: name })
  return fn
}

export interface CodeRunnerOptions {
  tools?: HostTool[] | ToolRegistry
  /** Default limits for every run; overridable per run. */
  limits?: RunLimits
  /**
   * Statically type-check code before executing it (monty's built-in `ty`),
   * with registered tools and inputs declared as typed stubs. Catches wrong
   * argument types, bad methods on tool results, and undefined names before
   * any side effects run. Default true.
   */
  typeCheck?: boolean
}

/**
 * Executes sandboxed Python with host tools exposed as plain functions.
 *
 * Owns the start/resume loop directly instead of using monty's `runMontyAsync`,
 * which masks Python runtime errors raised after a resume (it re-injects them
 * into the consumed snapshot — see docs/research/03-monty.md). Owning the loop
 * also gives us per-call tracing, abort checks between resumes, and host errors
 * raised into Python as catchable exceptions.
 */
export class CodeRunner {
  readonly registry: ToolRegistry
  private readonly limits: RunLimits
  private readonly typeCheck: boolean

  constructor(options: CodeRunnerOptions = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits }
    this.typeCheck = options.typeCheck ?? true
    this.registry =
      options.tools instanceof ToolRegistry ? options.tools : new ToolRegistry(options.tools)
  }

  addTool(tool: HostTool): void {
    this.registry.add(tool)
  }

  getTools(): HostTool[] {
    return this.registry.list()
  }

  async run(code: string, options: RunOptions = {}): Promise<RunResult> {
    const calls: ToolCallTrace[] = []
    const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES
    let stdout = ''
    let stdoutBytes = 0
    let stdoutTruncated = false
    const printCallback = (_stream: string, text: string) => {
      options.onPrint?.(text)
      stdoutBytes += Buffer.byteLength(text)
      if (stdoutBytes <= maxStdoutBytes) stdout += text
      else stdoutTruncated = true
      // must not return a value: the native layer raises TypeError otherwise
    }

    const scriptName = options.scriptName ?? 'tool.py'
    const lineOffset = options.lineOffset ?? 0

    const inputNames = options.inputs ? Object.keys(options.inputs) : []
    for (const name of inputNames) {
      if (!/^[a-z_][a-z0-9_]*$/i.test(name) || PYTHON_KEYWORDS.has(name)) {
        throw new Error(`Input name '${name}' is not a valid Python identifier`)
      }
    }

    // The type checker doesn't know tools, declared inputs, or some runtime
    // builtins; feed all three in as prefix code, then shift reported line
    // numbers back to the user's code.
    const prefixLines: string[] = []
    if (this.typeCheck) {
      typeCheckerGaps ??= probeTypeCheckerGaps()
      prefixLines.push('from typing import Any')
      for (const name of [...typeCheckerGaps, ...inputNames]) {
        prefixLines.push(`${name}: Any = None`)
      }
      const stubs = this.registry.renderTypeStubs()
      if (stubs) prefixLines.push(stubs)
    }
    const prefix = prefixLines.join('\n')
    const prefixLineCount = prefix === '' ? 0 : prefix.split('\n').length

    const fail = (
      errorKind: NonNullable<RunResult['errorKind']>,
      error: string,
    ): RunResult => ({ ok: false, output: undefined, stdout, stdoutTruncated, error, errorKind, calls })

    const locationRe = new RegExp(
      `${scriptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):`,
    )

    const adjustLines = (diagnosticLines: string[]): string =>
      diagnosticLines
        .map((line) =>
          line.replace(locationRe, (_m, raw) => `${scriptName}:${Number(raw) - prefixLineCount - lineOffset}:`),
        )
        .join('\n')

    // Splits ty diagnostics into ones about the user's code vs ones pointing
    // into our generated prefix (a host-side bug, e.g. a tool stub ty can't
    // parse) — the model can't act on the latter.
    const typingFailure = (e: MontyTypingError): RunResult | null => {
      const lines = e
        .displayDiagnostics('concise')
        .split('\n')
        .filter((line) => line.trim() !== '')
      const userLines = lines.filter((line) => {
        const match = locationRe.exec(line)
        return !match || Number(match[1]) > prefixLineCount
      })
      if (userLines.length === 0) return null // all prefix-resident: degrade below
      const kind = userLines.every((line) => line.includes('error[invalid-syntax]'))
        ? 'syntax'
        : 'typing'
      return fail(kind, adjustLines(userLines))
    }

    const pythonFailure = (e: unknown): RunResult => {
      if (e instanceof MontyRuntimeError) return fail('runtime', e.display('traceback'))
      if (e instanceof MontyTypingError) return typingFailure(e) ?? fail('typing', e.display())
      if (e instanceof MontySyntaxError) return fail('syntax', e.display('type-msg'))
      throw e
    }

    const montyOptions = {
      scriptName,
      inputs: inputNames.length > 0 ? inputNames : undefined,
    }
    let monty: Monty
    try {
      monty = new Monty(code, {
        ...montyOptions,
        typeCheck: this.typeCheck,
        typeCheckPrefixCode: prefix || undefined,
      })
    } catch (e) {
      if (e instanceof MontyTypingError) {
        const failure = typingFailure(e)
        if (failure) return failure
        // every diagnostic pointed into the generated prefix — run unchecked
        // rather than failing on code the model never wrote
        try {
          monty = new Monty(code, montyOptions)
        } catch (e2) {
          return pythonFailure(e2)
        }
      } else {
        return pythonFailure(e)
      }
    }

    const limits = { ...this.limits, ...options.limits } as ResourceLimits
    let progress: MontySnapshot | MontyNameLookup | MontyComplete
    try {
      progress = monty.start({ inputs: options.inputs, limits, printCallback, mount: options.mount })
    } catch (e) {
      return pythonFailure(e)
    }

    while (!(progress instanceof MontyComplete)) {
      if (options.signal?.aborted) return fail('aborted', 'Run aborted by the host')

      if (progress instanceof MontyNameLookup) {
        const known = this.registry.has(progress.variableName)
        try {
          // A known tool referenced without being called (aliased, stored, passed
          // around). Monty reports calls through the value under the JS function's
          // `name`, so a placeholder named after the tool keeps dispatch working.
          progress = known
            ? progress.resume({ value: namedPlaceholder(progress.variableName) })
            : progress.resume()
        } catch (e) {
          return pythonFailure(e)
        }
        continue
      }

      const snapshot: MontySnapshot = progress
      const tool = this.registry.get(snapshot.functionName)
      let resumeArg: Parameters<MontySnapshot['resume']>[0]
      if (!tool) {
        resumeArg = {
          exception: {
            type: 'NameError',
            message: `name '${snapshot.functionName}' is not defined`,
          },
        }
      } else {
        const trace: ToolCallTrace = {
          tool: tool.name,
          args: snapshot.args,
          kwargs: snapshot.kwargs,
          durationMs: 0,
          ok: false,
        }
        const startedAt = performance.now()
        let denial: string | null = null
        if (tool.requiresApproval) {
          if (!options.onApproval) {
            trace.approved = false
            denial = `${tool.name} requires approval but no approver is configured`
          } else {
            // the script is frozen at this call while the human decides
            const approved = await options.onApproval({
              tool: tool.name,
              args: snapshot.args,
              kwargs: snapshot.kwargs,
              description: tool.description,
            })
            trace.approved = approved
            if (!approved) denial = `${tool.name} call denied by the user`
          }
        }
        if (denial !== null) {
          trace.error = `PermissionError: ${denial}`
          resumeArg = { exception: { type: 'PermissionError', message: denial } }
        } else {
          try {
            const result = await tool.execute(snapshot.args, snapshot.kwargs)
            trace.ok = true
            resumeArg = { returnValue: result }
          } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e))
            const pythonType = err instanceof HostToolError ? err.pythonType : 'RuntimeError'
            trace.error = `${pythonType}: ${err.message}`
            resumeArg = { exception: { type: pythonType, message: err.message } }
          }
        }
        trace.durationMs = performance.now() - startedAt
        calls.push(trace)
      }

      if (options.signal?.aborted) return fail('aborted', 'Run aborted by the host')
      try {
        progress = snapshot.resume(resumeArg)
      } catch (e) {
        return pythonFailure(e)
      }
    }

    return { ok: true, output: progress.output, stdout, stdoutTruncated, calls }
  }
}
