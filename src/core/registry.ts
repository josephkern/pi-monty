import { Monty } from '@pydantic/monty'
import type { HostTool, HostToolParam } from './types.js'

/** Holds host tools and renders the Python stubs the model sees. */
export class ToolRegistry {
  private readonly tools = new Map<string, HostTool>()
  private typeStubCache: string | null = null

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
    this.typeStubCache = null
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

  /**
   * Compact stubs for monty's static type checker (`typeCheckPrefixCode`).
   * Bodies must raise (`...` bodies trip ty's empty-body rule) and optional
   * params default to None (`= ...` is only legal in .pyi stubs). Each stub
   * is validated against ty itself: a tool whose param/return strings aren't
   * real type expressions (they were prompt-only metadata before typeCheck
   * existed) degrades to an unchecked `name: Any = None` declaration instead
   * of poisoning the whole prefix. Cached until the next add().
   */
  renderTypeStubs(): string {
    this.typeStubCache ??= this.list().map(validatedTypeStub).join('\n')
    return this.typeStubCache
  }
}

function renderParams(tool: HostTool, optionalSuffix: (p: HostToolParam) => string): string {
  return tool.params
    .map((p) => `${p.name}: ${p.type}${p.optional ? optionalSuffix(p) : ''}`)
    .join(', ')
}

function validatedTypeStub(tool: HostTool): string {
  const params = renderParams(tool, (p) => ` | None = None`)
  const stub = `def ${tool.name}(${params}) -> ${tool.returns}:\n    raise NotImplementedError`
  try {
    new Monty('pass', { typeCheck: true, typeCheckPrefixCode: stub })
    return stub
  } catch {
    return `${tool.name}: Any = None`
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
  const params = renderParams(tool, () => ' = ...')

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

/** Counterexample pool for the import rule; filtered against what's importable. */
const BLOCKED_EXAMPLES = ['time', 'random', 'collections', 'requests', 'numpy']

/**
 * Ground rules for the model writing sandboxed Python, reflecting monty's
 * verified behavior (docs/research/03-monty.md). Include alongside the stubs.
 * Pass the result of `probeImportableModules()` so the import list reflects
 * the installed interpreter rather than a guess.
 */
export function renderPythonToolRules(importableModules: string[]): string {
  const blocked = BLOCKED_EXAMPLES.filter((m) => !importableModules.includes(m))
  return `\
- Call tools as plain functions, WITHOUT \`await\`.
- Use print() to surface anything you need to see; printed output is returned to you.
- The value of the last top-level expression is returned as the result (expressions
  inside if/try blocks are not).
- Imports: ONLY these modules exist: ${importableModules.join(', ')}. Anything else
  (e.g. ${blocked.join(', ')}) raises ModuleNotFoundError — there are no third-party
  packages.
- Class definitions and match statements are not supported.
- Tool failures raise normal Python exceptions you can catch (e.g. ValueError,
  FileNotFoundError, OSError).`
}
