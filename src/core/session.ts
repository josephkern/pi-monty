import { CodeRunner } from './runner.js'
import { ToolRegistry } from './registry.js'
import type { ApprovalRequest, HostTool, RunLimits, RunOptions, RunResult } from './types.js'

interface Snippet {
  code: string
  inputs?: Record<string, unknown>
}

interface CachedCall {
  tool: string
  result: unknown
}

interface SuspendedRun {
  /** The snippet abandoned at a gated call; resuming = re-running it. */
  code: string
  /** Cache length before the suspended run — the rollback point. */
  cacheLen: number
}

interface SessionState {
  version: 1
  snippets: Snippet[]
  calls: CachedCall[]
  stdout: string
  suspended?: SuspendedRun
}

export interface SessionOptions {
  tools?: HostTool[] | ToolRegistry
  /** Default limits for every run (applied to the whole replayed script). */
  limits?: RunLimits
  /** Pre-execution static type checking (see CodeRunnerOptions). Default true. */
  typeCheck?: boolean
}

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

  /** The gated snippet awaiting a decision; re-run the same code to resume. */
  get suspendedCode(): string | null {
    return this.suspended?.code ?? null
  }

  async run(code: string, options: RunOptions = {}): Promise<RunResult> {
    // A suspended run resumes by re-running the same snippet: its executed
    // calls stayed cached, so replay skips straight to the pending gated
    // call. Running anything ELSE abandons the suspension and rolls those
    // partial-run calls out of the cache to keep replay alignment.
    const resuming = this.suspended !== null && this.suspended.code === code
    if (this.suspended && !resuming) {
      this.calls = this.calls.slice(0, this.suspended.cacheLen)
    }
    const rollbackTo = resuming ? this.suspended!.cacheLen : this.calls.length
    this.suspended = null

    const transcript = this.snippets.map((s) => s.code.replace(/\n+$/, ''))
    const combined = [...transcript, code.replace(/\n+$/, '')].join('\n')
    const transcriptText = transcript.join('\n')
    const transcriptLines = transcriptText === '' ? 0 : transcriptText.split('\n').length
    const inputs = this.mergedInputs(options.inputs)

    // Replay wrapper: serve recorded host-tool calls from the cache so side
    // effects never run twice. Cache entries appended by this run are kept
    // only if the run succeeds or suspends.
    const serveBefore = this.calls.length
    let callIndex = 0
    let served = 0
    const liveCalls = this.calls
    const wrapped = new ToolRegistry(
      this.registry.list().map((tool) => ({
        ...tool,
        execute: async (args: unknown[], kwargs: Record<string, unknown>) => {
          const index = callIndex++
          const cached = index < serveBefore ? liveCalls[index] : undefined
          if (cached && cached.tool === tool.name) {
            served++
            return cached.result
          }
          const result = await tool.execute(args, kwargs)
          liveCalls.push({ tool: tool.name, result })
          return result
        },
      })),
    )

    // Replay re-prints earlier snippets' output; forward only chunks past it.
    const replayChars = this.stdout.length
    let printed = 0
    const onPrint = options.onPrint
      ? (text: string) => {
          const start = printed
          printed += text.length
          if (printed > replayChars) options.onPrint!(text.slice(Math.max(0, replayChars - start)))
        }
      : undefined

    // Replayed gated calls are served from the cache — no side effect can
    // happen — so don't re-prompt for decisions the user already made.
    const onApproval = options.onApproval
      ? (request: ApprovalRequest) => {
          const cached = callIndex < serveBefore ? liveCalls[callIndex] : undefined
          if (cached && cached.tool === request.tool) return true as const
          return options.onApproval!(request)
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

    // Surface only this snippet's contribution, not the replayed prefix.
    // Slice by length (not startsWith) so a replay whose output drifted —
    // e.g. a mounted file changed on disk — doesn't re-emit old output.
    const fullStdout = result.stdout
    result.stdout = fullStdout.slice(this.stdout.length)
    result.calls = result.calls.slice(served)

    if (result.ok) {
      this.snippets.push({ code, inputs: options.inputs })
      this.stdout = fullStdout
    } else if (result.errorKind === 'suspended') {
      // keep this run's executed calls cached so resuming doesn't repeat them
      this.suspended = { code, cacheLen: rollbackTo }
    } else {
      this.calls = this.calls.slice(0, rollbackTo)
    }
    return result
  }

  reset(): void {
    this.snippets = []
    this.calls = []
    this.stdout = ''
    this.suspended = null
  }

  dump(): string {
    const state: SessionState = {
      version: 1,
      snippets: this.snippets,
      calls: this.calls,
      stdout: this.stdout,
      ...(this.suspended ? { suspended: this.suspended } : {}),
    }
    return JSON.stringify(state)
  }

  static load(json: string, options: SessionOptions = {}): Session {
    const state = JSON.parse(json) as SessionState
    if (state.version !== 1) throw new Error(`Unsupported session version: ${state.version}`)
    const session = new Session(options)
    session.snippets = state.snippets
    session.calls = state.calls
    session.stdout = state.stdout
    session.suspended = state.suspended ?? null
    return session
  }

  private mergedInputs(current?: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = {}
    for (const snippet of this.snippets) Object.assign(merged, snippet.inputs)
    Object.assign(merged, current)
    return merged
  }
}
