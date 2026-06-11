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
