import { CodeRunner } from './runner.js'
import { ToolRegistry } from './registry.js'
import { DEFAULT_MAX_STDOUT_BYTES, appendCappedUtf8 } from './stdout.js'
import { HostToolError } from './types.js'
import type { ApprovalRequest, HostTool, RunLimits, RunOptions, RunResult } from './types.js'

interface Snippet {
  code: string
  inputs?: Record<string, unknown>
}

interface CachedCall {
  tool: string
  /** JSON identity of the call's args/kwargs; absent in pre-v2 states (matches any). */
  key?: string
  result?: unknown
  /** Host-tool exception raised into Python; replay re-raises the same exception. */
  error?: { pythonType: string; message: string }
  /** The user denied this gated call; replay re-raises without re-prompting. */
  denied?: true
}

interface SuspendedRun {
  /** The snippet stopped at a gated call; resume() replays it up to the gate. */
  code: string
  /** Cache length before the suspended run — the rollback point. */
  cacheLen: number
  /** Output the partial run already delivered, suppressed again on resume. */
  stdout: string
  /** Actual character count for partial output; stdout may be capped/truncated. */
  stdoutChars?: number
  /** Inputs the suspended run was started with, re-applied on resume. */
  inputs?: Record<string, unknown>
}

interface SessionState {
  version: number
  snippets: Snippet[]
  calls: CachedCall[]
  stdout: string
  /** Actual character count for committed stdout; stdout may be capped/truncated. */
  stdoutChars?: number
  suspended?: SuspendedRun
}

export interface SessionOptions {
  tools?: HostTool[] | ToolRegistry
  /** Default limits for every run (applied to the whole replayed script). */
  limits?: RunLimits
  /** Pre-execution static type checking (see CodeRunnerOptions). Default true. */
  typeCheck?: boolean
}

const normalize = (code: string) => code.replace(/\n+$/, '')

const callKey = (args: unknown[], kwargs: Record<string, unknown>) =>
  JSON.stringify([args, kwargs])

/**
 * A persistent Python session: variables and functions defined in one `run()`
 * are available in the next.
 *
 * monty's `MontyRepl` cannot dispatch external functions or capture print
 * (verified on 0.0.18 — `feed()` takes only `mount`), so sessions replay
 * instead: each run executes the transcript of successful snippets plus the
 * new code in a fresh interpreter, serving prior host-tool calls from a
 * recorded cache so their side effects don't repeat. Failed snippets are
 * dropped entirely — they leave no namespace changes behind (though host
 * calls they made before failing did execute once).
 *
 * State serializes to plain JSON (`dump()`/`Session.load()`), so snippets,
 * cached results, and inputs must stay JSON-serializable.
 */
export class Session {
  private readonly registry: ToolRegistry
  private readonly limits?: RunLimits
  private readonly typeCheck?: boolean
  private snippets: Snippet[] = []
  private calls: CachedCall[] = []
  private stdout = ''
  private stdoutChars = 0
  private suspended: SuspendedRun | null = null

  constructor(options: SessionOptions = {}) {
    this.registry =
      options.tools instanceof ToolRegistry ? options.tools : new ToolRegistry(options.tools)
    this.limits = options.limits
    this.typeCheck = options.typeCheck
  }

  /** Number of successful snippets in the transcript. */
  get length(): number {
    return this.snippets.length
  }

  /** The gated snippet awaiting a decision; call resume() to continue it. */
  get suspendedCode(): string | null {
    return this.suspended?.code ?? null
  }

  async run(code: string, options: RunOptions = {}): Promise<RunResult> {
    if (this.suspended) {
      throw new Error('A run is suspended; call resume() or abandon() before running new code')
    }
    return this.execute(code, options, null)
  }

  /** Resume the currently suspended snippet, preserving its original code and inputs. */
  async resume(options: RunOptions = {}): Promise<RunResult> {
    if (!this.suspended) throw new Error('No suspended run to resume')
    return this.execute(this.suspended.code, options, this.suspended)
  }

  /** Discard a pending suspension and roll back its pre-gate cached calls. */
  abandon(): boolean {
    if (!this.suspended) return false
    this.calls = this.calls.slice(0, this.suspended.cacheLen)
    this.suspended = null
    return true
  }

  private async execute(
    code: string,
    options: RunOptions,
    prior: SuspendedRun | null,
  ): Promise<RunResult> {
    const resuming = prior !== null
    const rollbackTo = resuming ? prior!.cacheLen : this.calls.length
    if (resuming) this.suspended = null

    const transcript = this.snippets.map((s) => normalize(s.code))
    const combined = [...transcript, normalize(code)].join('\n')
    const transcriptText = transcript.join('\n')
    const transcriptLines = transcriptText === '' ? 0 : transcriptText.split('\n').length
    const runInputs =
      resuming && prior!.inputs ? { ...prior!.inputs, ...options.inputs } : options.inputs
    const inputs = this.mergedInputs(runInputs)

    // Replay wrapper: serve recorded host-tool calls from the cache so side
    // effects never run twice. Entries are matched against the live call's
    // identity (tool + arguments); a mismatch means the replay diverged —
    // stop serving the stale tail and execute live from there.
    const cacheEnd = this.calls.length
    let serveBefore = cacheEnd
    let cursor = 0
    let served = 0
    let divergedAt: number | null = null
    const liveCalls = this.calls
    const diverge = () => {
      if (divergedAt === null) {
        divergedAt = cursor
        serveBefore = cursor
      }
    }
    const matches = (entry: CachedCall, tool: string, key: string) =>
      entry.tool === tool && (entry.key === undefined || entry.key === key)
    const wrapped = new ToolRegistry(
      this.registry.list().map((tool) => ({
        ...tool,
        execute: async (args: unknown[], kwargs: Record<string, unknown>) => {
          const key = callKey(args, kwargs)
          const entry = cursor < serveBefore ? liveCalls[cursor] : undefined
          if (entry && !entry.denied && matches(entry, tool.name, key)) {
            cursor++
            served++
            if (entry.error) {
              throw new HostToolError(entry.error.message, entry.error.pythonType)
            }
            return entry.result
          }
          if (entry) diverge()
          try {
            const result = await tool.execute(args, kwargs)
            liveCalls.push({ tool: tool.name, key, result })
            return result
          } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e))
            const pythonType = err instanceof HostToolError ? err.pythonType : 'RuntimeError'
            liveCalls.push({ tool: tool.name, key, error: { pythonType, message: err.message } })
            throw e
          }
        },
      })),
    )

    // Replay re-prints earlier output (committed transcript plus a suspended
    // run's already-delivered partial output); forward and capture only chunks
    // past it. Track actual character counts separately from capped captured
    // stdout so truncation doesn't make replayed tail look new later.
    const priorStdoutChars = resuming ? (prior!.stdoutChars ?? prior!.stdout.length) : 0
    const replayChars = this.stdoutChars + priorStdoutChars
    const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES
    let printed = 0
    let stdout = { text: '', bytes: 0, truncated: false }
    const onPrint = (text: string) => {
      const start = printed
      printed += text.length
      if (printed <= replayChars) return
      const fresh = text.slice(Math.max(0, replayChars - start))
      stdout = appendCappedUtf8(stdout, fresh, maxStdoutBytes)
      options.onPrint?.(fresh)
    }

    // Replayed gated calls were already decided: executed ones are served
    // from the cache (no side effect can happen) and denied ones re-raise
    // PermissionError, so the user is never re-asked for a decision they
    // already made. Live denials are recorded so replay stays aligned.
    const onApproval = options.onApproval
      ? async (request: ApprovalRequest): Promise<boolean | 'suspend'> => {
          const key = callKey(request.args, request.kwargs)
          const entry = cursor < serveBefore ? liveCalls[cursor] : undefined
          if (entry && matches(entry, request.tool, key)) {
            if (!entry.denied) return true // execute() serves the cached result
            cursor++
            served++
            return false
          }
          if (entry) diverge()
          const decision = await options.onApproval!(request)
          if (decision === false) liveCalls.push({ tool: request.tool, key, denied: true })
          return decision
        }
      : undefined

    const runner = new CodeRunner({ tools: wrapped, limits: this.limits, typeCheck: this.typeCheck })
    const result = await runner.run(combined, {
      ...options,
      onPrint,
      onApproval,
      inputs: Object.keys(inputs).length > 0 ? inputs : undefined,
      lineOffset: transcriptLines + (options.lineOffset ?? 0),
    })

    // Surface only this snippet's new contribution: not the replayed prefix,
    // and not output a suspension already delivered. This is captured from the
    // uncapped print stream rather than runner.stdout, because runner.stdout is
    // capped across the whole replayed script and prior output can consume it.
    result.stdout = stdout.text
    result.stdoutTruncated = stdout.truncated
    result.calls = result.calls.slice(served)

    // Entries from a divergence point up to the old cache end were proven
    // stale (the live run re-made those calls); drop them so the fresh
    // results pushed after them take their positions.
    const reconcile = () => {
      if (divergedAt !== null) {
        this.calls = [...this.calls.slice(0, divergedAt), ...this.calls.slice(cacheEnd)]
      }
    }
    // Everything the partial run has delivered so far, for suppression on
    // resume. A failed resume can end short of the prior partial output —
    // keep the longer record so nothing re-emits.
    const partialStdout = () => {
      const freshChars = Math.max(0, printed - replayChars)
      return {
        stdout: (resuming ? prior!.stdout : '') + stdout.text,
        stdoutChars: priorStdoutChars + freshChars,
      }
    }

    if (result.status === 'ok') {
      reconcile()
      this.snippets.push({ code, ...(runInputs ? { inputs: runInputs } : {}) })
      this.stdout += (resuming ? prior!.stdout : '') + result.stdout
      this.stdoutChars = printed
    } else if (result.status === 'suspended') {
      // keep this run's executed calls cached so resuming doesn't repeat
      // them, plus the delivered output and the inputs it ran with
      reconcile()
      const partial = partialStdout()
      this.suspended = {
        code,
        cacheLen: divergedAt === null ? rollbackTo : Math.min(rollbackTo, divergedAt),
        stdout: partial.stdout,
        stdoutChars: partial.stdoutChars,
        ...(runInputs ? { inputs: runInputs } : {}),
      }
    } else if (resuming && divergedAt === null) {
      // The resume failed past the gate (denial, tool error, abort). The
      // calls that DID execute are real side effects — keep them cached and
      // restore the suspension so retrying replays instead of re-executing.
      // Trailing denials are dropped so a retry asks for the decision again.
      while (this.calls.length > rollbackTo && this.calls[this.calls.length - 1]!.denied) {
        this.calls.pop()
      }
      const partial = partialStdout()
      this.suspended = {
        code,
        cacheLen: rollbackTo,
        stdout: partial.stdout,
        stdoutChars: partial.stdoutChars,
        ...(runInputs ? { inputs: runInputs } : {}),
      }
    } else {
      this.calls = this.calls.slice(0, rollbackTo)
    }
    return result
  }

  reset(): void {
    this.snippets = []
    this.calls = []
    this.stdout = ''
    this.stdoutChars = 0
    this.suspended = null
  }

  dump(): string {
    const state: SessionState = {
      version: 2,
      snippets: this.snippets,
      calls: this.calls,
      stdout: this.stdout,
      stdoutChars: this.stdoutChars,
      ...(this.suspended ? { suspended: this.suspended } : {}),
    }
    return JSON.stringify(state)
  }

  static load(json: string, options: SessionOptions = {}): Session {
    const state = JSON.parse(json) as SessionState
    if (state.version !== 1 && state.version !== 2) {
      throw new Error(`Unsupported session version: ${state.version}`)
    }
    const session = new Session(options)
    session.snippets = state.snippets
    session.calls = state.calls
    session.stdout = state.stdout
    session.stdoutChars = state.stdoutChars ?? state.stdout.length
    // pre-v2 suspensions lack the delivered-stdout record; resuming one
    // re-emits the partial output once rather than failing the restore
    session.suspended = state.suspended
      ? {
          ...state.suspended,
          stdout: state.suspended.stdout ?? '',
          stdoutChars: state.suspended.stdoutChars ?? (state.suspended.stdout ?? '').length,
        }
      : null
    return session
  }

  private mergedInputs(current?: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = {}
    for (const snippet of this.snippets) Object.assign(merged, snippet.inputs)
    Object.assign(merged, current)
    return merged
  }
}
