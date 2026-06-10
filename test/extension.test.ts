import { describe, expect, it } from 'vitest'
import { createPythonExtension } from '../src/pi/extension.js'
import type { HostTool } from '../src/index.js'

type AnyTool = {
  name: string
  description: string
  execute: (
    id: string,
    params: { code: string; reset?: boolean },
    signal?: AbortSignal,
    onUpdate?: (partial: unknown) => void,
    ctx?: unknown,
  ) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>
}

async function loadExtension(options: Parameters<typeof createPythonExtension>[0] = {}) {
  const tools: AnyTool[] = []
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => void)[]>()
  const api = {
    registerTool: (tool: AnyTool) => tools.push(tool),
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
  }
  await createPythonExtension({ toolStore: false, ...options })(api as never)
  if (tools.length !== 1) throw new Error('expected exactly one registered tool')
  return { tool: tools[0], handlers }
}

const greet: HostTool = {
  name: 'greet',
  description: 'Greet someone.',
  params: [{ name: 'name', type: 'str' }],
  returns: 'str',
  execute: ([name]) => `hello ${name}`,
}

describe('python pi extension', () => {
  it('registers a code tool with stubs and rules in the description', async () => {
    const { tool } = await loadExtension({ tools: [greet], noBuiltins: true })
    expect(tool.name).toBe('code')
    expect(tool.description).toContain('def greet(name: str) -> str:')
    expect(tool.description).toContain('WITHOUT `await`')
  })

  it('honors a custom tool name', async () => {
    const { tool } = await loadExtension({ toolName: 'python', noBuiltins: true })
    expect(tool.name).toBe('python')
  })

  it('includes builtin stubs by default', async () => {
    const { tool } = await loadExtension({ root: '/tmp' })
    expect(tool.description).toContain('def read_file(')
    expect(tool.description).toContain('def http_get(')
  })

  it('runs code, returns the result, and persists state across calls', async () => {
    const { tool } = await loadExtension({ tools: [greet], noBuiltins: true })
    const first = await tool.execute('t1', { code: 'msg = greet("pi")\nmsg' })
    expect(first.content[0].text).toBe('=> "hello pi"')
    expect(first.details.ok).toBe(true)
    expect(first.details.calls).toEqual(['greet'])

    const second = await tool.execute('t2', { code: 'msg.upper()' })
    expect(second.content[0].text).toBe('=> "HELLO PI"')
  })

  it('streams print output via onUpdate and reports it in the final content', async () => {
    const { tool } = await loadExtension({ noBuiltins: true })
    const updates: string[] = []
    const result = await tool.execute(
      't1',
      { code: 'for i in range(3):\n    print(i)' },
      undefined,
      (partial) => {
        const p = partial as { content: { text: string }[] }
        updates.push(p.content[0].text)
      },
    )
    expect(updates.at(-1)).toBe('0\n1\n2\n')
    expect(result.content[0].text).toBe('0\n1\n2\n')
  })

  it('returns tracebacks as content, not a throw', async () => {
    const { tool } = await loadExtension({ noBuiltins: true })
    const result = await tool.execute('t1', { code: '1 / 0' })
    expect(result.details.ok).toBe(false)
    expect(result.content[0].text).toContain('ZeroDivisionError')
  })

  it('resets state when asked', async () => {
    const { tool } = await loadExtension({ noBuiltins: true })
    await tool.execute('t1', { code: 'x = 1' })
    const result = await tool.execute('t2', { code: 'x', reset: true })
    expect(result.details.ok).toBe(false)
    expect(result.content[0].text).toContain('NameError')
  })

  it('restores session state from branch details on session_start', async () => {
    const { tool, handlers } = await loadExtension({ tools: [greet], noBuiltins: true })
    const first = await tool.execute('t1', { code: 'kept = greet("again")' })

    // Simulate a fresh pi session whose branch contains the prior tool result.
    const sessionStart = handlers.get('session_start')![0]
    sessionStart(
      {},
      {
        sessionManager: {
          getBranch: () => [
            { type: 'message', message: { toolName: 'code', details: first.details } },
          ],
        },
      },
    )

    const result = await tool.execute('t2', { code: 'kept' })
    expect(result.content[0].text).toBe('=> "hello again"')
  })

  it('restores state recorded under the legacy python tool name', async () => {
    const { tool, handlers } = await loadExtension({ noBuiltins: true })
    const first = await tool.execute('t1', { code: 'legacy = 7' })

    const sessionStart = handlers.get('session_start')![0]
    sessionStart(
      {},
      {
        sessionManager: {
          getBranch: () => [
            { type: 'message', message: { toolName: 'python', details: first.details } },
          ],
        },
      },
    )

    const result = await tool.execute('t2', { code: 'legacy' })
    expect(result.content[0].text).toBe('=> 7')
  })
})
