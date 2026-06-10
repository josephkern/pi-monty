import type { HostTool } from './types.js'

/** Holds host tools and renders the Python stubs the model sees. */
export class ToolRegistry {
  private readonly tools = new Map<string, HostTool>()

  constructor(tools: HostTool[] = []) {
    for (const tool of tools) this.add(tool)
  }

  add(tool: HostTool): void {
    if (!/^[a-z_][a-z0-9_]*$/i.test(tool.name)) {
      throw new Error(`Tool name '${tool.name}' is not a valid Python identifier`)
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`)
    }
    this.tools.set(tool.name, tool)
  }

  get(name: string): HostTool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  list(): HostTool[] {
    return [...this.tools.values()]
  }

  /** Python stubs for every registered tool, for the system/tool prompt. */
  renderStubs(): string {
    return this.list().map(renderToolStub).join('\n\n')
  }
}

/**
 * Renders one tool as a Python function stub with a docstring, e.g.:
 *
 *     def read_file(path: str) -> str:
 *         """Read a text file.
 *
 *         Args:
 *             path: Path relative to the workspace root.
 *
 *         Returns:
 *             str: the file text
 *         """
 */
export function renderToolStub(tool: HostTool): string {
  const params = tool.params
    .map((p) => `${p.name}: ${p.type}${p.optional ? ' = ...' : ''}`)
    .join(', ')

  const doc: string[] = [tool.description.trim()]
  const described = tool.params.filter((p) => p.description)
  if (described.length > 0) {
    doc.push('', 'Args:')
    for (const p of described) doc.push(`    ${p.name}: ${p.description}`)
  }
  if (tool.returnsDescription) {
    doc.push('', 'Returns:', `    ${tool.returns}: ${tool.returnsDescription}`)
  }

  const body = doc.length === 1 ? `"""${doc[0]}"""` : `"""${doc.join('\n')}\n"""`
  const indented = body
    .split('\n')
    .map((line) => (line === '' ? '' : `    ${line}`))
    .join('\n')
  return `def ${tool.name}(${params}) -> ${tool.returns}:\n${indented}`
}

/**
 * Ground rules for the model writing sandboxed Python, reflecting monty's
 * verified behavior (docs/research/03-monty.md). Include alongside the stubs.
 */
export const PYTHON_TOOL_RULES = `\
- Call tools as plain functions, WITHOUT \`await\`.
- Use print() to surface anything you need to see; printed output is returned to you.
- The value of the last top-level expression is returned as the result (expressions
  inside if/try blocks are not).
- Class definitions and match statements are not supported; only a small stdlib subset
  (re, json, datetime, math) is importable.
- Tool failures raise normal Python exceptions you can catch (e.g. ValueError,
  FileNotFoundError, OSError).`
