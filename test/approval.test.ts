import { describe, expect, it } from 'vitest'
import { CodeRunner, Session } from '../src/index.js'
import type { ApprovalRequest, HostTool } from '../src/index.js'

function gatedTool(): { tool: HostTool; executions: number[] } {
  const executions: number[] = []
  return {
    executions,
    tool: {
      name: 'deploy',
      description: 'Deploy a build.',
      params: [{ name: 'target', type: 'str' }],
      returns: 'str',
      requiresApproval: true,
      execute: ([target]) => {
        executions.push(1)
        return `deployed to ${target}`
      },
    },
  }
}

describe('approval gates', () => {
  it('runs the call when approved and records the decision', async () => {
    const { tool, executions } = gatedTool()
    const requests: ApprovalRequest[] = []
    const runner = new CodeRunner({ tools: [tool] })
    const result = await runner.run('deploy("staging")', {
      onApproval: (request) => {
        requests.push(request)
        return true
      },
    })
    expect(result.ok).toBe(true)
    expect(result.output).toBe('deployed to staging')
    expect(executions).toHaveLength(1)
    expect(requests).toEqual([
      { tool: 'deploy', args: ['staging'], kwargs: {}, description: 'Deploy a build.' },
    ])
    expect(result.calls[0]).toMatchObject({ tool: 'deploy', ok: true, approved: true })
  })

  it('raises a catchable PermissionError when denied', async () => {
    const { tool, executions } = gatedTool()
    const runner = new CodeRunner({ tools: [tool] })
    const result = await runner.run(
      'try:\n    deploy("prod")\n    msg = "deployed"\nexcept PermissionError as e:\n    msg = f"blocked: {e}"\nmsg',
      { onApproval: () => false },
    )
    expect(result.ok).toBe(true)
    expect(result.output).toBe('blocked: deploy call denied by the user')
    expect(executions).toHaveLength(0)
    expect(result.calls[0]).toMatchObject({ ok: false, approved: false })
  })

  it('denies gated calls when no approver is configured', async () => {
    const { tool, executions } = gatedTool()
    const runner = new CodeRunner({ tools: [tool] })
    const result = await runner.run('deploy("prod")')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('PermissionError')
    expect(result.error).toContain('no approver is configured')
    expect(executions).toHaveLength(0)
  })

  it('does not re-ask for approved calls on session replay', async () => {
    const { tool, executions } = gatedTool()
    let asked = 0
    const session = new Session({ tools: [tool] })
    const onApproval = () => {
      asked++
      return true
    }
    await session.run('a = deploy("one")', { onApproval })
    await session.run('b = deploy("two")\n[a, b]', { onApproval })
    expect(asked).toBe(2) // one decision per distinct call, none for the replay
    expect(executions).toHaveLength(2)
  })

  it('leaves ungated tools untouched by the approver', async () => {
    const plain: HostTool = {
      name: 'ping',
      description: 'Ping.',
      params: [],
      returns: 'str',
      execute: () => 'pong',
    }
    let asked = 0
    const result = await new CodeRunner({ tools: [plain] }).run('ping()', {
      onApproval: () => {
        asked++
        return true
      },
    })
    expect(result.output).toBe('pong')
    expect(asked).toBe(0)
  })
})

describe('suspend and resume (durable approval)', () => {
  function sideEffectTool(): { tool: HostTool; log: string[] } {
    const log: string[] = []
    return {
      log,
      tool: {
        name: 'notify',
        description: 'Send a notification.',
        params: [{ name: 'msg', type: 'str' }],
        returns: 'str',
        execute: ([msg]) => {
          log.push(String(msg))
          return `sent ${msg}`
        },
      },
    }
  }

  const SNIPPET = `pre = notify("before")
result = deploy("prod")
post = notify("after")
f"{pre}|{result}|{post}"`

  it('suspends at the gate, then resumes without repeating side effects', async () => {
    const { tool: gated, executions } = gatedTool()
    const { tool: notify, log } = sideEffectTool()
    const session = new Session({ tools: [gated, notify] })

    const suspended = await session.run(SNIPPET, { onApproval: () => 'suspend' })
    expect(suspended.ok).toBe(false)
    expect(suspended.errorKind).toBe('suspended')
    expect(suspended.suspendedCall).toMatchObject({ tool: 'deploy', args: ['prod'] })
    expect(executions).toHaveLength(0) // gate never executed
    expect(log).toEqual(['before']) // pre-gate side effect ran once
    expect(session.suspendedCode).toBe(SNIPPET)

    const resumed = await session.run(SNIPPET, { onApproval: () => true })
    expect(resumed.ok).toBe(true)
    expect(resumed.output).toBe('sent before|deployed to prod|sent after')
    expect(executions).toHaveLength(1)
    expect(log).toEqual(['before', 'after']) // "before" replayed from cache
    expect(session.suspendedCode).toBeNull()
  })

  it('survives dump/load between suspension and resume', async () => {
    const { tool: gated, executions } = gatedTool()
    const { tool: notify, log } = sideEffectTool()
    const session = new Session({ tools: [gated, notify] })
    await session.run(SNIPPET, { onApproval: () => 'suspend' })

    // "days later, new process": fresh tool instances, state from JSON only
    const { tool: gated2, executions: executions2 } = gatedTool()
    const { tool: notify2, log: log2 } = sideEffectTool()
    const restored = Session.load(session.dump(), { tools: [gated2, notify2] })
    expect(restored.suspendedCode).toBe(SNIPPET)

    const resumed = await restored.run(SNIPPET, { onApproval: () => true })
    expect(resumed.ok).toBe(true)
    expect(resumed.output).toBe('sent before|deployed to prod|sent after')
    expect(executions2).toHaveLength(1)
    expect(log2).toEqual(['after']) // 'before' served from the restored cache
    expect(executions).toHaveLength(0)
    expect(log).toEqual(['before'])
  })

  it('resuming with a denial raises PermissionError at the gate', async () => {
    const { tool: gated, executions } = gatedTool()
    const { tool: notify } = sideEffectTool()
    const session = new Session({ tools: [gated, notify] })
    await session.run(SNIPPET, { onApproval: () => 'suspend' })

    const denied = await session.run(SNIPPET, { onApproval: () => false })
    expect(denied.ok).toBe(false)
    expect(denied.error).toContain('PermissionError')
    expect(executions).toHaveLength(0)
  })

  it('running different code abandons the suspension cleanly', async () => {
    const { tool: gated } = gatedTool()
    const { tool: notify, log } = sideEffectTool()
    const session = new Session({ tools: [gated, notify] })
    await session.run(SNIPPET, { onApproval: () => 'suspend' })

    const other = await session.run('notify("fresh")')
    expect(other.ok).toBe(true)
    expect(session.suspendedCode).toBeNull()
    // partial-run cache rolled back: 'before' re-executes if SNIPPET re-runs later
    expect(log).toEqual(['before', 'fresh'])
    const again = await session.run('notify("more")\nlen("x")')
    expect(again.ok).toBe(true)
    expect(log).toEqual(['before', 'fresh', 'more'])
  })
})
