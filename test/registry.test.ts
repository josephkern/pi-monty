import { describe, expect, it } from 'vitest'
import { ToolRegistry, renderToolStub } from '../src/index.js'
import type { HostTool } from '../src/index.js'

const fullTool: HostTool = {
  name: 'search_records',
  description: 'Search records by query.',
  params: [
    { name: 'query', type: 'str', description: 'Search query.' },
    { name: 'limit', type: 'int', description: 'Max results.', optional: true },
  ],
  returns: 'list[dict]',
  returnsDescription: 'records with keys "id" and "score"',
  execute: () => [],
}

const bareTool: HostTool = {
  name: 'ping',
  description: 'Check connectivity.',
  params: [],
  returns: 'bool',
  execute: () => true,
}

describe('renderToolStub', () => {
  it('renders signature, docstring args, and returns', () => {
    expect(renderToolStub(fullTool)).toBe(
      `def search_records(query: str, limit: int = ...) -> list[dict]:
    """Search records by query.

    Args:
        query: Search query.
        limit: Max results.

    Returns:
        list[dict]: records with keys "id" and "score"
    """`,
    )
  })

  it('renders a one-line docstring when there is nothing else', () => {
    expect(renderToolStub(bareTool)).toBe(
      `def ping() -> bool:
    """Check connectivity."""`,
    )
  })
})

describe('ToolRegistry', () => {
  it('joins stubs with blank lines', () => {
    const registry = new ToolRegistry([bareTool, fullTool])
    const stubs = registry.renderStubs()
    expect(stubs).toContain('def ping()')
    expect(stubs).toContain('def search_records(')
    expect(stubs.split('\n\n').length).toBeGreaterThanOrEqual(2)
  })

  it('validates names and rejects duplicates', () => {
    const registry = new ToolRegistry()
    expect(() => registry.add({ ...bareTool, name: '2bad' })).toThrow(/identifier/)
    registry.add(bareTool)
    expect(() => registry.add(bareTool)).toThrow(/already registered/)
  })
})
