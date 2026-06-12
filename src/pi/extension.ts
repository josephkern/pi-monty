/**
 * pi extension: a `code` code-mode tool backed by monty's sandboxed Python
 * interpreter. Host tools appear to the model as plain Python functions;
 * print() output streams back; variables persist across calls within a
 * session; session state rides in tool-result `details` so it survives
 * session restore and branching.
 *
 * Use directly with `pi -e src/pi/extension.ts`, or copy/symlink into
 * `.pi/extensions/`.
 */
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from '@earendil-works/pi-coding-agent'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { MountDir } from '@pydantic/monty'
import { probeImportableModules } from '../core/capabilities.js'
import { renderPythonToolRules, ToolRegistry } from '../core/registry.js'
import { createBuiltinTools } from '../core/builtins.js'
import { Session } from '../core/session.js'
import { ToolStore } from '../core/toolstore.js'
import { createPiBridgeTools } from './bridge.js'
import type { ApprovalRequest, HostTool, RunLimits } from '../core/types.js'

const DEFAULT_TOOL_NAME = 'code'

/**
 * Labels of the gated-call approval dialog. pi's `ctx.ui.select` returns the
 * chosen label string, so these are load-bearing for routing the decision —
 * tests and RPC drivers should import them rather than re-typing the text.
 */
export const APPROVAL_CHOICES = {
  approve: 'Approve',
  deny: 'Deny',
  suspend: 'Decide later (suspends the script, resumable any time)',
} as const

export interface PythonExtensionOptions {
  /**
   * Name the tool is registered under. Default 'code' — neutral across model
   * families; a name like 'python' invites full-CPython assumptions monty
   * can't meet.
   */
  toolName?: string
  /** Extra host tools beyond the built-ins. */
  tools?: HostTool[]
  /** Workspace root for the built-in file tools. Default: process.cwd(). */
  root?: string
  /** Disable the built-in tools (list_files, http_get, and read_file when the mount is off). */
  noBuiltins?: boolean
  /**
   * Mount the workspace read-only at /workspace so code reads files with
   * plain open()/pathlib. When disabled, a read_file host tool is provided
   * instead. Default true.
   */
  mountWorkspace?: boolean
  /** Pre-execution static type checking with tool stubs. Default true. */
  typeCheck?: boolean
  /**
   * Bridge pi's built-in tools into the sandbox as Python functions:
   * read/grep/find/ls dispatch directly; bash/edit/write pause for per-call
   * user approval. Default true.
   */
  bridgePiTools?: boolean
  /**
   * Approve gated (bash/edit/write) calls without asking. Headless escape
   * hatch — without it, gated calls are denied when no UI is available.
   * Default false.
   */
  autoApprove?: boolean
  /**
   * Directory for agent-saved tools, or false to disable saving.
   * Default: <root>/.pi/code-tools.
   */
  toolStore?: string | false
  /** Interpreter limits per run (applied to the replayed transcript). */
  limits?: RunLimits
}

interface PythonDetails {
  ok: boolean
  /** Serialized Session (JSON) for branch-safe restore. */
  state: string
  /** Names of host tools called by this snippet. */
  calls: string[]
}

const PythonParams = Type.Object({
  code: Type.String({
    description:
      'Python code to run. The value of the last top-level expression is returned.',
  }),
  reset: Type.Optional(
    Type.Boolean({
      description: 'Discard all session state and reload saved tools before running.',
    }),
  ),
  resume: Type.Optional(
    Type.Boolean({
      description:
        'Re-run the snippet that was suspended awaiting approval (code is ignored). ' +
        'Work done before the suspension is not repeated.',
    }),
  ),
})

export function createPythonExtension(options: PythonExtensionOptions = {}) {
  return async (pi: ExtensionAPI) => {
    const toolName = options.toolName ?? DEFAULT_TOOL_NAME
    const root = options.root ?? process.cwd()
    // One MountDir per run: monty rejects a mount shared with another live
    // run, and suspended runs stay live (they hold their mount) until GC'd.
    let makeMount: (() => MountDir) | undefined
    if (options.mountWorkspace ?? true) {
      try {
        if (!statSync(root).isDirectory()) throw new Error('not a directory')
        makeMount = () => new MountDir('/workspace', root, { mode: 'read-only' })
      } catch {
        // root missing/unreadable: degrade to the read_file tool rather than
        // failing the whole extension load
        makeMount = undefined
      }
    }
    const bridge = options.bridgePiTools ?? true
    const registry = new ToolRegistry(options.tools)
    if (bridge) {
      for (const tool of createPiBridgeTools(root)) registry.add(tool)
    }
    if (!options.noBuiltins) {
      // the mount replaces read_file with plain open(); bridged ls replaces list_files
      for (const tool of createBuiltinTools({ root, readFile: !makeMount, listFiles: !bridge })) {
        registry.add(tool)
      }
    }
    const store =
      options.toolStore === false ? null : new ToolStore(options.toolStore ?? join(root, '.pi', 'code-tools'))
    if (store) {
      // saved code must work in a future session, not just this one: run it
      // in an isolated session (other saved tools loaded, current session's
      // imports/variables absent) before accepting it. The probe needs its
      // own MountDir — the suspended outer run still holds the shared one,
      // and monty rejects a mount attached to two runs at once.
      const validate = async (code: string): Promise<string | null> => {
        const probeMount = makeMount?.()
        const probe = await freshSession({ quiet: true, mount: probeMount })
        const result = await probe.run(code, { mount: probeMount })
        return result.ok ? null : ((result.error ?? 'unknown error').split('\n')[0] ?? null)
      }
      for (const tool of store.hostTools((name) => registry.has(name), validate)) {
        registry.add(tool)
      }
    }
    const savedSummary = store ? await store.renderSummary() : ''
    const gatedNames = registry
      .list()
      .filter((t) => t.requiresApproval)
      .map((t) => t.name)

    const sessionOptions = { tools: registry, limits: options.limits, typeCheck: options.typeCheck }
    // null until first use: a fresh session loads saved tools as a prelude,
    // which is async, so creation happens lazily in execute().
    let session: Session | null = null
    let preludeNote = ''
    // set when state came from a previous conversation and hasn't run yet
    let restoredUnverified = false

    async function freshSession(
      opts: { quiet?: boolean; mount?: MountDir } = {},
    ): Promise<Session> {
      const fresh = new Session(sessionOptions)
      if (!store) return fresh
      const saved = await store.list()
      if (saved.length === 0) return fresh
      const loadMount = opts.mount ?? makeMount?.()
      // Per-file loading, looping until the failed set stops shrinking: a
      // malformed file skips just that tool, and dependency chains load in
      // any order (monty resolves a function's globals only if they were
      // defined BEFORE it — retrying failures effectively topo-sorts, which
      // a single combined snippet cannot guarantee).
      let pending: { name: string; code: string; error?: string }[] = saved
      while (pending.length > 0) {
        const failed: typeof pending = []
        for (const tool of pending) {
          const loaded = await fresh.run(tool.code, { mount: loadMount })
          if (!loaded.ok) failed.push({ ...tool, error: (loaded.error ?? '').split('\n')[0] })
        }
        if (failed.length === pending.length) {
          if (!opts.quiet) {
            const skipped = failed.map((p) => `${p.name} (${p.error})`).join('; ')
            preludeNote = `[note: skipped saved tool(s) that failed to load: ${skipped}]\n\n`
          }
          break
        }
        pending = failed
      }
      return fresh
    }

    // Rebuild session state from the last python tool result on the current
    // branch — `details` travels with the session file, so this survives
    // restores and branching.
    pi.on('session_start', (_event, ctx) => {
      let state: string | undefined
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === 'message') {
          const message = entry.message as { toolName?: string; details?: PythonDetails }
          if (message.toolName === toolName && message.details?.state) {
            state = message.details.state
          }
        }
      }
      try {
        session = state ? Session.load(state, sessionOptions) : null
      } catch {
        // unreadable state (e.g. written by an incompatible version): start
        // fresh rather than failing every session start
        session = null
        state = undefined
      }
      restoredUnverified = Boolean(state)
    })

    pi.registerTool({
      name: toolName,
      label: 'Code',
      description: [
        'Run Python in a sandboxed interpreter with host tools available as plain',
        'functions. Variables and functions persist across calls in this session.',
        'Prefer this tool when you need to chain tool calls, loop, filter large',
        'results, or compute — do the work in code and print only what you need.',
        '',
        'Functions available INSIDE the code (these are not separate tools — invoke',
        `them from Python passed to ${toolName}):`,
        '',
        registry.renderStubs(),
        ...(savedSummary
          ? [
              '',
              'Saved functions (auto-loaded into new sessions — call them from your',
              `code like any function, e.g. via ${toolName} with "result = name(...)"):`,
              savedSummary,
            ]
          : []),
        '',
        'Rules:',
        renderPythonToolRules(probeImportableModules()),
        ...(gatedNames.length > 0
          ? [
              `- Calls to ${gatedNames.join('/')} pause the script for per-call user approval; a denial raises PermissionError (catch it or stop gracefully), and the user may suspend the script instead — resume later with {"resume": true}. Group related work so the user approves meaningful units.`,
            ]
          : []),
        ...(makeMount
          ? [
              `- The workspace is mounted READ-ONLY at /workspace: read files with open("/workspace/<path>") or pathlib (paths from list_files are relative to it). Files are not iterable — use .read()/.readlines(); parse JSON with json.loads(text). Writes raise PermissionError; change real files with the regular edit/write tools.`,
            ]
          : []),
      ].join('\n'),
      promptSnippet: `${toolName}: run sandboxed Python; host tools are callable as functions; state persists`,
      promptGuidelines: [
        `Use ${toolName} for multi-step tool workflows: loop/filter/aggregate in code and print only the result, instead of issuing many separate tool calls.`,
        ...(bridge
          ? [
              `Route file changes by how the content is produced. DERIVED content — computed from data (manifests, indexes, conversions, extractions), the same mechanical transform across many files, or writes that must pass programmatic checks first — belongs inside ${toolName} via write()/edit(): code computes it exactly, verifies before writing, and each mutation is shown for approval. AUTHORED content — new code or prose you are composing, or a single judgment-driven edit — belongs in the regular edit/write tools.`,
            ]
          : []),
        ...(registry.list().length > 0
          ? [
              `Functions listed in the ${toolName} tool description (${registry
                .list()
                .slice(0, 3)
                .map((t) => t.name)
                .join(', ')}, ...) are NOT standalone tools — they only exist inside ${toolName}'s Python environment. To use one, call ${toolName} with code that invokes it.`,
            ]
          : []),
        ...(store
          ? [
              `To create a reusable saved tool, call save_tool(name, code, description) inside ${toolName} — it validates the code. Do not write files into .pi/code-tools directly.`,
            ]
          : []),
      ],
      parameters: PythonParams,
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        if (params.reset || !session) {
          session = await freshSession()
          restoredUnverified = false
        }

        // gated calls freeze the script while the human decides in the TUI;
        // "decide later" suspends the run (resumable via resume=true, even
        // after a restart — the suspension rides in the session state);
        // headless runs deny unless autoApprove opts in
        const onApproval = async (request: ApprovalRequest): Promise<boolean | 'suspend'> => {
          if (options.autoApprove) return true
          if (!ctx?.hasUI) return false
          const choice = await ctx.ui.select(`Approve ${formatCall(request)}?`, [
            APPROVAL_CHOICES.approve,
            APPROVAL_CHOICES.deny,
            APPROVAL_CHOICES.suspend,
          ])
          if (choice === APPROVAL_CHOICES.approve) return true
          if (choice === APPROVAL_CHOICES.suspend) return 'suspend'
          return false
        }

        let code = params.code
        if (params.resume) {
          const pending = session.suspendedCode
          if (!pending) {
            return {
              content: [{ type: 'text', text: '(nothing is suspended — run code normally)' }],
              details: { ok: false, state: session.dump(), calls: [] },
            }
          }
          code = pending
        }

        let streamed = ''
        const result = await session.run(code, {
          signal,
          mount: makeMount?.(),
          onApproval,
          onPrint: (text) => {
            streamed += text
            onUpdate?.({
              content: [{ type: 'text', text: streamed }],
              details: { ok: true, state: '', calls: [] },
            })
          },
        })

        // running new code while a script was suspended silently dropped its
        // pending gated call — say so, or the user's "resume" later makes no sense
        const abandonNote = result.abandonedSuspension
          ? '[note: this run abandoned the previously suspended script — its pending gated call was discarded]\n'
          : ''
        let text = abandonNote + preludeNote + result.stdout
        preludeNote = ''
        if (result.ok) {
          if (result.output !== null && result.output !== undefined) {
            if (text && !text.endsWith('\n')) text += '\n'
            text += `=> ${formatValue(result.output)}`
          }
          if (!text) text = '(no output)'
        } else if (result.errorKind === 'suspended') {
          if (text && !text.endsWith('\n')) text += '\n'
          text += `[suspended] The script is paused awaiting user approval of ${
            result.suspendedCall ? formatCall(result.suspendedCall, 200) : 'a gated call'
          }. Nothing after that call has run; completed work will not repeat. STOP and tell the user what is pending — do NOT call this tool again until the user explicitly says they have decided. Then continue with {"resume": true} (works even in a later session).`
        } else {
          if (text && !text.endsWith('\n')) text += '\n'
          text += result.error
          if (restoredUnverified) {
            text +=
              '\n[note: session state was restored from an earlier conversation; if this error references older code, retry with reset=true]'
          }
        }
        restoredUnverified = false

        const truncation = truncateHead(text, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        })
        let finalText = truncation.content
        if (truncation.truncated) finalText += '\n[output truncated]'

        // dump unconditionally: failed runs can still change session state
        // (consuming or abandoning a suspension), and enumerating which
        // outcomes mutate it here would duplicate Session's rollback rules
        return {
          content: [{ type: 'text', text: finalText }],
          details: {
            ok: result.ok,
            state: session.dump(),
            calls: result.calls.map((c) => c.tool),
          } satisfies PythonDetails,
        }
      },
    })
  }
}

function formatValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function formatCall(request: ApprovalRequest, maxLength = 400): string {
  const parts = [
    ...request.args.map(formatValue),
    ...Object.entries(request.kwargs).map(([k, v]) => `${k}=${formatValue(v)}`),
  ]
  const rendered = `${request.tool}(${parts.join(', ')})`
  return rendered.length > maxLength ? `${rendered.slice(0, maxLength)}…` : rendered
}

export default createPythonExtension()
