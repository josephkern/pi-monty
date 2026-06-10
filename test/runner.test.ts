import { describe, expect, it } from 'vitest'
import { CodeRunner, HostToolError } from '../src/index.js'
import type { HostTool } from '../src/index.js'

const double: HostTool = {
  name: 'double',
  description: 'Double a number.',
  params: [{ name: 'n', type: 'int' }],
  returns: 'int',
  execute: ([n]) => (n as number) * 2,
}

const fetchData: HostTool = {
  name: 'fetch_data',
  description: 'Fetch a record by id.',
  params: [{ name: 'id', type: 'str' }],
  returns: 'dict',
  execute: async ([id]) => ({ id, value: 42 }),
}

describe('CodeRunner basics', () => {
  it('returns the last expression', async () => {
    const result = await new CodeRunner().run('1 + 2')
    expect(result).toMatchObject({ ok: true, output: 3, stdout: '', calls: [] })
  })

  it('injects inputs as variables', async () => {
    const result = await new CodeRunner().run('x * y', { inputs: { x: 6, y: 7 } })
    expect(result.output).toBe(42)
  })

  it('captures print output', async () => {
    const result = await new CodeRunner().run('print("a")\nprint("b", 2)')
    expect(result.stdout).toBe('a\nb 2\n')
    expect(result.stdoutTruncated).toBe(false)
  })

  it('truncates stdout beyond the cap', async () => {
    const result = await new CodeRunner().run('for i in range(100):\n    print("x" * 10)', {
      maxStdoutBytes: 50,
    })
    expect(result.ok).toBe(true)
    expect(result.stdoutTruncated).toBe(true)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(50)
  })
})

describe('host tools', () => {
  it('dispatches sync and async tools', async () => {
    const runner = new CodeRunner({ tools: [double, fetchData] })
    const result = await runner.run('record = fetch_data("a1")\ndouble(record["value"])')
    expect(result.output).toBe(84)
    expect(result.calls.map((c) => c.tool)).toEqual(['fetch_data', 'double'])
    expect(result.calls.every((c) => c.ok)).toBe(true)
  })

  it('passes args and kwargs', async () => {
    const seen: unknown[] = []
    const runner = new CodeRunner({
      tools: [
        {
          name: 'record',
          description: 'Record args.',
          params: [],
          returns: 'None',
          execute: (args, kwargs) => {
            seen.push([args, kwargs])
            return null
          },
        },
      ],
    })
    const result = await runner.run('record(1, "two", flag=True)')
    expect(result.ok).toBe(true)
    expect(seen).toEqual([[[1, 'two'], { flag: true }]])
  })

  it('loops over tool calls with state in the sandbox', async () => {
    const runner = new CodeRunner({ tools: [double] })
    const result = await runner.run(
      'total = 0\nfor i in [1, 2, 3]:\n    total += double(i)\nprint(total)\ntotal',
    )
    expect(result.output).toBe(12)
    expect(result.stdout).toBe('12\n')
    expect(result.calls).toHaveLength(3)
  })

  it('rejects invalid tool names and duplicates', () => {
    const runner = new CodeRunner({ tools: [double] })
    expect(() => runner.addTool({ ...double, name: 'not valid' })).toThrow(/identifier/)
    expect(() => runner.addTool(double)).toThrow(/already registered/)
  })
})

describe('error paths', () => {
  it('reports syntax errors', async () => {
    const result = await new CodeRunner().run('def f(:')
    expect(result.ok).toBe(false)
    expect(result.errorKind).toBe('syntax')
    expect(result.error).toContain('SyntaxError')
  })

  it('reports runtime errors with a traceback', async () => {
    const result = await new CodeRunner().run('def f():\n    return 1 / 0\nf()')
    expect(result.ok).toBe(false)
    expect(result.errorKind).toBe('runtime')
    expect(result.error).toContain('ZeroDivisionError')
    expect(result.error).toContain('line 2')
  })

  it('keeps stdout and calls from before a runtime error', async () => {
    const runner = new CodeRunner({ tools: [double] })
    const result = await runner.run('print(double(2))\n1 / 0')
    expect(result.ok).toBe(false)
    expect(result.stdout).toBe('4\n')
    expect(result.calls).toHaveLength(1)
  })

  it('raises NameError for unknown functions', async () => {
    const result = await new CodeRunner().run('mystery(1)')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('NameError')
    expect(result.error).toContain('mystery')
  })

  it('surfaces host tool failures as catchable Python exceptions', async () => {
    const runner = new CodeRunner({
      tools: [
        {
          name: 'flaky',
          description: 'Always fails.',
          params: [],
          returns: 'None',
          execute: () => {
            throw new HostToolError('record not found', 'ValueError')
          },
        },
      ],
    })
    const caught = await runner.run(
      'try:\n    flaky()\n    msg = "no error"\nexcept ValueError as e:\n    msg = f"caught: {e}"\nmsg',
    )
    expect(caught.ok).toBe(true)
    expect(caught.output).toBe('caught: record not found')
    expect(caught.calls[0]).toMatchObject({ ok: false, error: 'ValueError: record not found' })

    const uncaught = await runner.run('flaky()')
    expect(uncaught.ok).toBe(false)
    expect(uncaught.error).toContain('ValueError: record not found')
  })

  it('maps plain JS errors to RuntimeError', async () => {
    const runner = new CodeRunner({
      tools: [
        {
          name: 'boom',
          description: 'Throws a plain error.',
          params: [],
          returns: 'None',
          execute: () => {
            throw new Error('wires crossed')
          },
        },
      ],
    })
    const result = await runner.run('boom()')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('RuntimeError: wires crossed')
  })

  it('dispatches calls made through aliases', async () => {
    const runner = new CodeRunner({ tools: [double] })
    const result = await runner.run('f = double\nf(2) + f(3)')
    expect(result.ok).toBe(true)
    expect(result.output).toBe(10)
    expect(result.calls.map((c) => c.tool)).toEqual(['double', 'double'])
  })

  it('enforces the time limit', async () => {
    const result = await new CodeRunner().run('while True:\n    pass', {
      limits: { maxDurationSecs: 1 },
    })
    expect(result.ok).toBe(false)
    expect(result.errorKind).toBe('runtime')
    expect(result.error).toContain('time limit exceeded')
  })

  it('stops on abort during a host tool call', async () => {
    const controller = new AbortController()
    const runner = new CodeRunner({
      tools: [
        {
          name: 'slow',
          description: 'Aborts mid-flight.',
          params: [],
          returns: 'None',
          execute: async () => {
            controller.abort()
            return null
          },
        },
      ],
    })
    const result = await runner.run('slow()\nprint("never")', { signal: controller.signal })
    expect(result.ok).toBe(false)
    expect(result.errorKind).toBe('aborted')
    expect(result.stdout).not.toContain('never')
  })
})
