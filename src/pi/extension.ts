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
import { join } from 'node:path'
import { PYTHON_TOOL_RULES, ToolRegistry } from '../core/registry.js'
import { createBuiltinTools } from '../core/builtins.js'
import { Session } from '../core/session.js'
import { ToolStore } from '../core/toolstore.js'
import type { HostTool, RunLimits } from '../core/types.js'

const DEFAULT_TOOL_NAME = 'code'

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
  /** Disable the built-in read_file/list_files/http_get tools. */
  noBuiltins?: boolean
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
})

export function createPythonExtension(options: PythonExtensionOptions = {}) {
  return async (pi: ExtensionAPI) => {
    const toolName = options.toolName ?? DEFAULT_TOOL_NAME
    const root = options.root ?? process.cwd()
    const registry = new ToolRegistry(options.tools)
    if (!options.noBuiltins) {
      for (const tool of createBuiltinTools({ root })) registry.add(tool)
    }
    const store =
      options.toolStore === false ? null : new ToolStore(options.toolStore ?? join(root, '.pi', 'code-tools'))
    if (store) {
      for (const tool of store.hostTools((name) => registry.has(name))) registry.add(tool)
    }
    const savedSummary = store ? await store.renderSummary() : ''

    const sessionOptions = { tools: registry, limits: options.limits }
    // null until first use: a fresh session loads saved tools as a prelude,
    // which is async, so creation happens lazily in execute().
    let session: Session | null = null
    let preludeNote = ''

    async function freshSession(): Promise<Session> {
      const fresh = new Session(sessionOptions)
      const prelude = store ? await store.prelude() : ''
      if (prelude) {
        const loaded = await fresh.run(prelude)
        if (!loaded.ok) {
          preludeNote = `[note: loading saved tools failed, continuing without them]\n${loaded.error}\n\n`
          fresh.reset()
        }
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
      session = state ? Session.load(state, sessionOptions) : null
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
              'Saved functions (already defined in the session — call them from your',
              `code like any function, e.g. via ${toolName} with "result = name(...)"):`,
              savedSummary,
            ]
          : []),
        '',
        'Rules:',
        PYTHON_TOOL_RULES,
      ].join('\n'),
      promptSnippet: `${toolName}: run sandboxed Python; host tools are callable as functions; state persists`,
      promptGuidelines: [
        `Use ${toolName} for multi-step tool workflows: loop/filter/aggregate in code and print only the result, instead of issuing many separate tool calls.`,
        `Functions listed in the ${toolName} tool description (read_file, http_get, save_tool, and any saved functions) are NOT standalone tools — they only exist inside ${toolName}'s Python environment. To use one, call ${toolName} with code that invokes it.`,
      ],
      parameters: PythonParams,
      async execute(_toolCallId, params, signal, onUpdate, _ctx) {
        if (params.reset || !session) session = await freshSession()

        let streamed = ''
        const result = await session.run(params.code, {
          signal,
          onPrint: (text) => {
            streamed += text
            onUpdate?.({
              content: [{ type: 'text', text: streamed }],
              details: { ok: true, state: '', calls: [] },
            })
          },
        })

        let text = preludeNote + result.stdout
        preludeNote = ''
        if (result.ok) {
          if (result.output !== null && result.output !== undefined) {
            if (text && !text.endsWith('\n')) text += '\n'
            text += `=> ${formatValue(result.output)}`
          }
          if (!text) text = '(no output)'
        } else {
          if (text && !text.endsWith('\n')) text += '\n'
          text += result.error
        }

        const truncation = truncateHead(text, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        })
        let finalText = truncation.content
        if (truncation.truncated) finalText += '\n[output truncated]'

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

export default createPythonExtension()
