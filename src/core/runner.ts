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
import { ToolRegistry } from './registry.js'
import { HostToolError } from './types.js'
import type { HostTool, RunLimits, RunOptions, RunResult, ToolCallTrace } from './types.js'

const DEFAULT_LIMITS: Required<Pick<RunLimits, 'maxDurationSecs' | 'maxMemory'>> = {
  maxDurationSecs: 5,
  maxMemory: 64 * 1024 * 1024,
}

const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024

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

  constructor(options: CodeRunnerOptions = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits }
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
      stdoutBytes += Buffer.byteLength(text)
      if (stdoutBytes <= maxStdoutBytes) stdout += text
      else stdoutTruncated = true
      // must not return a value: the native layer raises TypeError otherwise
    }

    const fail = (
      errorKind: NonNullable<RunResult['errorKind']>,
      error: string,
    ): RunResult => ({ ok: false, output: undefined, stdout, stdoutTruncated, error, errorKind, calls })

    const pythonFailure = (e: unknown): RunResult => {
      if (e instanceof MontyRuntimeError) return fail('runtime', e.display('traceback'))
      if (e instanceof MontyTypingError) return fail('typing', e.displayDiagnostics('concise'))
      if (e instanceof MontySyntaxError) return fail('syntax', e.display('type-msg'))
      throw e
    }

    let monty: Monty
    try {
      monty = new Monty(code, {
        scriptName: options.scriptName ?? 'tool.py',
        inputs: options.inputs ? Object.keys(options.inputs) : undefined,
      })
    } catch (e) {
      return pythonFailure(e)
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
