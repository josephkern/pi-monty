/**
 * Bridges pi's own built-in tools (read/grep/find/ls and, gated behind
 * approval, bash/edit/write) into the sandbox as plain Python functions —
 * the Cloudflare "code mode" conversion: tool schema → typed stub. The model
 * can then loop/filter/compose pi's real tools in one snippet instead of one
 * model round-trip per call.
 */
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-coding-agent'
import { HostToolError } from '../core/types.js'
import type { HostTool, HostToolParam } from '../core/types.js'

/** The slice of pi's AgentTool the bridge relies on. */
interface PiTool {
  name: string
  description: string
  parameters: {
    properties?: Record<string, JsonSchema>
    required?: string[]
  }
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: ({ type: string } & Record<string, unknown>)[] }>
}

interface JsonSchema {
  type?: string
  description?: string
  anyOf?: JsonSchema[]
  enum?: unknown[]
}

export interface BridgeOptions {
  /** Gate bash/edit/write behind per-call approval. Default true. */
  gateMutating?: boolean
}

/**
 * Wraps pi's built-in tools as host tools for the sandbox. Read-only tools
 * (read, grep, find, ls) dispatch directly; mutating tools (bash, edit,
 * write) carry requiresApproval so each call pauses for a human decision.
 */
export function createPiBridgeTools(cwd: string, options: BridgeOptions = {}): HostTool[] {
  const gate = options.gateMutating ?? true
  const readOnly = [createReadTool, createGrepTool, createFindTool, createLsTool]
  const mutating = [createBashTool, createEditTool, createWriteTool]
  return [
    ...readOnly.map((factory) => wrapPiTool(factory(cwd) as unknown as PiTool, false)),
    ...mutating.map((factory) => wrapPiTool(factory(cwd) as unknown as PiTool, gate)),
  ]
}

function wrapPiTool(tool: PiTool, requiresApproval: boolean): HostTool {
  const params = schemaToParams(tool.parameters)
  const positional = params.map((p) => p.name)
  let counter = 0
  return {
    name: tool.name,
    description: firstSentences(tool.description),
    params,
    returns: 'str',
    returnsDescription: 'the tool output as text',
    requiresApproval,
    async execute(args, kwargs) {
      const input: Record<string, unknown> = {}
      args.forEach((value, index) => {
        const name = positional[index]
        if (!name) throw new HostToolError(`${tool.name} takes at most ${positional.length} arguments`, 'TypeError')
        input[name] = value
      })
      for (const [key, value] of Object.entries(kwargs)) {
        if (key in input) throw new HostToolError(`got multiple values for argument '${key}'`, 'TypeError')
        input[key] = value
      }
      let result: Awaited<ReturnType<PiTool['execute']>>
      try {
        result = await tool.execute(`bridge-${tool.name}-${counter++}`, input)
      } catch (e) {
        throw new HostToolError((e as Error).message, 'RuntimeError')
      }
      return result.content
        .map((block) => (block.type === 'text' ? String(block.text ?? '') : `[${block.type}]`))
        .join('\n')
    },
  }
}

function schemaToParams(schema: PiTool['parameters']): HostToolParam[] {
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties ?? {}).map(([name, prop]) => ({
    name,
    type: pythonType(prop),
    description: prop.description,
    optional: !required.has(name),
  }))
}

function pythonType(schema: JsonSchema): string {
  if (schema.anyOf) {
    const parts = [...new Set(schema.anyOf.map(pythonType))]
    return parts.join(' | ')
  }
  switch (schema.type) {
    case 'string':
      return 'str'
    case 'integer':
      return 'int'
    case 'number':
      return 'float'
    case 'boolean':
      return 'bool'
    case 'array':
      return 'list'
    case 'object':
      return 'dict'
    default:
      return 'object'
  }
}

/** Tool descriptions can be long LLM prompts; keep stub docstrings compact. */
function firstSentences(text: string, maxLength = 200): string {
  const flattened = text.replace(/\s+/g, ' ').trim()
  if (flattened.length <= maxLength) return flattened
  const cut = flattened.slice(0, maxLength)
  const lastStop = cut.lastIndexOf('. ')
  return lastStop > 40 ? cut.slice(0, lastStop + 1) : `${cut}…`
}
