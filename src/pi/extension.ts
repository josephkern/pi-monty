/**
 * pi extension: a `python` code-mode tool backed by monty's sandboxed
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
import { PYTHON_TOOL_RULES, ToolRegistry } from '../core/registry.js'
import { createBuiltinTools } from '../core/builtins.js'
import { Session } from '../core/session.js'
import type { HostTool, RunLimits } from '../core/types.js'

const TOOL_NAME = 'python'

export interface PythonExtensionOptions {
  /** Extra host tools beyond the built-ins. */
  tools?: HostTool[]
  /** Workspace root for the built-in file tools. Default: process.cwd(). */
  root?: string
  /** Disable the built-in read_file/list_files/http_get tools. */
  noBuiltins?: boolean
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
    Type.Boolean({ description: 'Discard all session state before running.' }),
  ),
})

export function createPythonExtension(options: PythonExtensionOptions = {}) {
  return (pi: ExtensionAPI) => {
    const registry = new ToolRegistry(options.tools)
    if (!options.noBuiltins) {
      for (const tool of createBuiltinTools({ root: options.root ?? process.cwd() })) {
        registry.add(tool)
      }
    }
    const sessionOptions = { tools: registry, limits: options.limits }
    let session = new Session(sessionOptions)

    // Rebuild session state from the last python tool result on the current
    // branch — `details` travels with the session file, so this survives
    // restores and branching.
    pi.on('session_start', (_event, ctx) => {
      let state: string | undefined
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === 'message') {
          const message = entry.message as { toolName?: string; details?: PythonDetails }
          if (message.toolName === TOOL_NAME && message.details?.state) {
            state = message.details.state
          }
        }
      }
      session = state ? Session.load(state, sessionOptions) : new Session(sessionOptions)
    })

    pi.registerTool({
      name: TOOL_NAME,
      label: 'Python',
      description: [
        'Run Python in a sandboxed interpreter with host tools available as plain',
        'functions. Variables and functions persist across calls in this session.',
        'Prefer this tool when you need to chain tool calls, loop, filter large',
        'results, or compute — do the work in code and print only what you need.',
        '',
        'Available functions:',
        '',
        registry.renderStubs(),
        '',
        'Rules:',
        PYTHON_TOOL_RULES,
      ].join('\n'),
      promptSnippet:
        'python: run sandboxed Python; host tools are callable as functions; state persists',
      promptGuidelines: [
        'Use python for multi-step tool workflows: loop/filter/aggregate in code and print only the result, instead of issuing many separate tool calls.',
      ],
      parameters: PythonParams,
      async execute(_toolCallId, params, signal, onUpdate, _ctx) {
        if (params.reset) session.reset()

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

        let text = result.stdout
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
