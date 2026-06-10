import { describe, expect, it } from 'vitest'
import { Session } from '../src/index.js'
import type { HostTool } from '../src/index.js'

function spyTool(): { tool: HostTool; executions: unknown[][] } {
  const executions: unknown[][] = []
  return {
    executions,
    tool: {
      name: 'fetch_record',
      description: 'Fetch a record.',
      params: [{ name: 'id', type: 'str' }],
      returns: 'dict',
      execute: ([id]) => {
        executions.push([id])
        return { id, seq: executions.length }
      },
    },
  }
}

describe('Session', () => {
  it('persists variables and functions across runs', async () => {
    const session = new Session()
    await session.run('x = 10\ndef triple(n):\n    return n * 3')
    const result = await session.run('triple(x) + 2')
    expect(result.ok).toBe(true)
    expect(result.output).toBe(32)
    expect(session.length).toBe(2)
  })

  it('does not re-execute host tools from earlier snippets', async () => {
    const { tool, executions } = spyTool()
    const session = new Session({ tools: [tool] })
    await session.run('a = fetch_record("a1")')
    expect(executions).toHaveLength(1)

    const result = await session.run('b = fetch_record("b2")\n[a["seq"], b["seq"]]')
    expect(executions).toHaveLength(2) // a1 served from cache, only b2 live
    expect(result.output).toEqual([1, 2])
    expect(result.calls).toHaveLength(1) // only the new call is reported
    expect(result.calls[0].tool).toBe('fetch_record')
  })

  it('reports only new stdout per run', async () => {
    const session = new Session()
    const first = await session.run('print("one")')
    expect(first.stdout).toBe('one\n')
    const second = await session.run('print("two")')
    expect(second.stdout).toBe('two\n')
  })

  it('rolls back failed snippets completely', async () => {
    const { tool, executions } = spyTool()
    const session = new Session({ tools: [tool] })
    await session.run('x = 1')

    const failed = await session.run('y = 2\nr = fetch_record("oops")\n1 / 0')
    expect(failed.ok).toBe(false)
    expect(session.length).toBe(1)
    expect(executions).toHaveLength(1) // the call happened once...

    const after = await session.run(
      'try:\n    y\n    found = True\nexcept NameError:\n    found = False\nfound',
    )
    // ...but the failed snippet left no state and its cache entry was dropped
    expect(after.ok).toBe(true)
    expect(after.output).toBe(false)
    expect(executions).toHaveLength(1)
  })

  it('keeps inputs available to later snippets', async () => {
    const session = new Session()
    await session.run('start = base + 1', { inputs: { base: 100 } })
    const result = await session.run('start + base')
    expect(result.output).toBe(201)
  })

  it('round-trips through dump/load without re-executing tools', async () => {
    const { tool, executions } = spyTool()
    const session = new Session({ tools: [tool] })
    await session.run('rec = fetch_record("a1")')
    await session.run('print(rec["id"])')

    const { tool: tool2, executions: executions2 } = spyTool()
    const restored = Session.load(session.dump(), { tools: [tool2] })
    const result = await restored.run('rec["seq"]')
    expect(result.ok).toBe(true)
    expect(result.output).toBe(1)
    expect(result.stdout).toBe('')
    expect(executions2).toHaveLength(0) // fully served from the restored cache
    expect(executions).toHaveLength(1)
  })

  it('reset clears all state', async () => {
    const session = new Session()
    await session.run('x = 5')
    session.reset()
    const result = await session.run('x')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('NameError')
  })
})
