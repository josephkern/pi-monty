import { describe, expect, it } from 'vitest'
import { APPROVAL_CHOICES, createPythonExtension } from '../src/pi/extension.js'
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

  it('lists the actually-importable modules in the rules', async () => {
    const { tool } = await loadExtension({ noBuiltins: true })
    expect(tool.description).toContain('ONLY these modules exist:')
    expect(tool.description).toMatch(/exist:.*\bjson\b/)
    expect(tool.description).toMatch(/exist:.*\bpathlib\b/)
    // time isn't importable in monty 0.0.18 — it must only appear as a counterexample
    expect(tool.description).not.toMatch(/exist:[^\n]*\btime\b/)
  })

  it('honors a custom tool name', async () => {
    const { tool } = await loadExtension({ toolName: 'python', noBuiltins: true })
    expect(tool.name).toBe('python')
  })

  it('mounts the workspace, bridges pi tools, and includes builtins by default', async () => {
    const { tool } = await loadExtension({ root: '/tmp' })
    expect(tool.description).toContain('def http_get(')
    // bridged pi tools, with mutating ones called out as approval-gated
    expect(tool.description).toContain('def grep(')
    expect(tool.description).toContain('def bash(')
    expect(tool.description).toContain('bash/edit/write pause the script')
    // the read-only mount replaces read_file; bridged ls replaces list_files
    expect(tool.description).not.toContain('def read_file(')
    expect(tool.description).not.toContain('def list_files(')
    expect(tool.description).toContain('/workspace')
  })

  it('keeps list_files and skips pi tools when the bridge is off', async () => {
    const { tool } = await loadExtension({ root: '/tmp', bridgePiTools: false })
    expect(tool.description).toContain('def list_files(')
    expect(tool.description).not.toContain('def bash(')
  })

  it('asks via ctx.ui.select for gated calls and honors the answer', async () => {
    const { tool } = await loadExtension({ root: process.cwd() })
    const titles: string[] = []
    const makeCtx = (answer: string) => ({
      hasUI: true,
      ui: {
        select: async (title: string, _options: string[]) => {
          titles.push(title)
          return answer
        },
      },
    })
    const denied = await tool.execute(
      't1',
      { code: 'bash("echo hi")' },
      undefined,
      undefined,
      makeCtx(APPROVAL_CHOICES.deny),
    )
    expect(denied.details.ok).toBe(false)
    expect(denied.content[0].text).toContain('PermissionError')
    expect(titles[0]).toContain('bash("echo hi")')

    const approved = await tool.execute(
      't2',
      { code: 'bash("echo hi").strip()' },
      undefined,
      undefined,
      makeCtx(APPROVAL_CHOICES.approve),
    )
    expect(approved.content[0].text).toContain('hi')

    // the dialog must show the whole call, not a 110-char prefix — the user
    // approves what they can read
    const long = `bash("echo start-${'x'.repeat(150)}-end")`
    await tool.execute('t3', { code: long }, undefined, undefined, makeCtx(APPROVAL_CHOICES.deny))
    expect(titles[2]).toContain('-end')
  })

  it('suspends on "Decide later" and resumes across a simulated restart', async () => {
    const { tool, handlers } = await loadExtension({ root: process.cwd() })
    const makeCtx = (answer: string) => ({
      hasUI: true,
      ui: { select: async () => answer },
    })

    const suspended = await tool.execute(
      't1',
      { code: 'pre = len("xy")\nout = bash("echo approved-later")\nf"{pre}:{out.strip()}"' },
      undefined,
      undefined,
      makeCtx(APPROVAL_CHOICES.suspend),
    )
    expect(suspended.details.ok).toBe(false)
    expect(suspended.content[0].text).toContain('[suspended]')
    expect(suspended.content[0].text).toContain('"resume": true')

    // restart pi: state (including the suspension) restores from details
    const sessionStart = handlers.get('session_start')![0]
    sessionStart(
      {},
      {
        sessionManager: {
          getBranch: () => [
            { type: 'message', message: { toolName: 'code', details: suspended.details } },
          ],
        },
      },
    )

    const resumed = await tool.execute(
      't2',
      { code: '', resume: true },
      undefined,
      undefined,
      makeCtx(APPROVAL_CHOICES.approve),
    )
    expect(resumed.details.ok).toBe(true)
    expect(resumed.content[0].text).toContain('2:approved-later')
  })

  it('persists the abandonment of a suspension even when the next run fails', async () => {
    const { tool, handlers } = await loadExtension({ root: process.cwd() })
    const makeCtx = (answer: string) => ({
      hasUI: true,
      ui: { select: async () => answer },
    })

    const suspended = await tool.execute(
      't1',
      { code: 'bash("echo pending")' },
      undefined,
      undefined,
      makeCtx(APPROVAL_CHOICES.suspend),
    )
    expect(suspended.content[0].text).toContain('[suspended]')

    // different code abandons the suspension — and tells the model so
    const failed = await tool.execute('t2', { code: '1 / 0' })
    expect(failed.content[0].text).toContain('abandoned the previously suspended script')
    expect(failed.content[0].text).toContain('ZeroDivisionError')

    // a restart restored from the FAILED run's details must not resurrect it
    const sessionStart = handlers.get('session_start')![0]
    sessionStart(
      {},
      {
        sessionManager: {
          getBranch: () => [
            { type: 'message', message: { toolName: 'code', details: failed.details } },
          ],
        },
      },
    )
    const resumed = await tool.execute('t3', { code: '', resume: true })
    expect(resumed.content[0].text).toContain('nothing is suspended')
  })

  it('explains when there is nothing to resume', async () => {
    const { tool } = await loadExtension({ noBuiltins: true, bridgePiTools: false })
    const result = await tool.execute('t1', { code: '', resume: true })
    expect(result.content[0].text).toContain('nothing is suspended')
  })

  it('denies gated calls headlessly unless autoApprove is set', async () => {
    const { tool } = await loadExtension({ root: process.cwd() })
    const headless = await tool.execute(
      't1',
      { code: 'bash("echo hi")' },
      undefined,
      undefined,
      { hasUI: false, ui: {} },
    )
    expect(headless.details.ok).toBe(false)
    expect(headless.content[0].text).toContain('PermissionError')

    const { tool: auto } = await loadExtension({ root: process.cwd(), autoApprove: true })
    const allowed = await auto.execute(
      't1',
      { code: 'bash("echo hi").strip()' },
      undefined,
      undefined,
      { hasUI: false, ui: {} },
    )
    expect(allowed.content[0].text).toContain('hi')
  })

  it('provides read_file when the mount is disabled', async () => {
    const { tool } = await loadExtension({ root: '/tmp', mountWorkspace: false })
    expect(tool.description).toContain('def read_file(')
    expect(tool.description).not.toContain('/workspace')
  })

  it('reads workspace files through the mount with open()', async () => {
    const { tool } = await loadExtension({ root: process.cwd() })
    const result = await tool.execute('t1', {
      code: 'import json\njson.loads(open("/workspace/package.json").read())["name"]',
    })
    const { default: pkg } = await import('../package.json', { with: { type: 'json' } })
    expect(result.content[0].text).toBe(`=> "${pkg.name}"`)
  })

  it('falls back to read_file when the mount root is missing', async () => {
    const { tool } = await loadExtension({ root: '/nonexistent-dir-for-pi-code-tool-test' })
    expect(tool.description).toContain('def read_file(')
    expect(tool.description).not.toContain('/workspace')
  })

  it('teaches the derived-vs-authored write split only when the bridge is on', async () => {
    const grab = async (options: Parameters<typeof createPythonExtension>[0]) => {
      const tools: { promptGuidelines?: string[] }[] = []
      await createPythonExtension({ toolStore: false, ...options })({
        registerTool: (t: unknown) => tools.push(t as (typeof tools)[number]),
        on: () => {},
      } as never)
      return tools[0].promptGuidelines!.join('\n')
    }
    expect(await grab({ root: '/tmp' })).toContain('DERIVED content')
    expect(await grab({ root: '/tmp', bridgePiTools: false })).not.toContain('DERIVED content')
  })

  it('derives guideline examples from the actual registry', async () => {
    const tools: { promptGuidelines?: string[] }[] = []
    const api = {
      registerTool: (t: unknown) => tools.push(t as (typeof tools)[number]),
      on: () => {},
    }
    await createPythonExtension({ tools: [greet], noBuiltins: true, toolStore: false })(
      api as never,
    )
    const guidelines = tools[0].promptGuidelines!.join('\n')
    expect(guidelines).toContain('greet')
    expect(guidelines).not.toContain('list_files')
  })

  it('hints at reset when a restored session fails its first run', async () => {
    const { tool, handlers } = await loadExtension({ noBuiltins: true })
    const first = await tool.execute('t1', { code: 'kept = 1' })

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

    const failed = await tool.execute('t2', { code: 'missing_name' })
    expect(failed.content[0].text).toContain('retry with reset=true')
    // the hint is one-shot
    const failedAgain = await tool.execute('t3', { code: 'missing_name' })
    expect(failedAgain.content[0].text).not.toContain('retry with reset=true')
  })

  it('persists unchanged state for ordinary failed runs', async () => {
    const { tool } = await loadExtension({ noBuiltins: true })
    const ok = await tool.execute('t1', { code: 'x = 1' })
    const failed = await tool.execute('t2', { code: '1 / 0' })
    expect(failed.details.state).toBe(ok.details.state)
  })

  it('blocks writes through the mount', async () => {
    const { tool } = await loadExtension({ root: process.cwd() })
    const result = await tool.execute('t1', {
      code: 'open("/workspace/evil.txt", "w").write("x")',
    })
    expect(result.details.ok).toBe(false)
    expect(result.content[0].text).toContain('PermissionError')
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
    expect(result.content[0].text).toContain('not defined')
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

  it('ignores state recorded under other tool names', async () => {
    const { tool, handlers } = await loadExtension({ noBuiltins: true })
    const first = await tool.execute('t1', { code: 'x = 7' })

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

    const result = await tool.execute('t2', { code: 'x' })
    expect(result.details.ok).toBe(false)
    expect(result.content[0].text).toContain('not defined')
  })
})
