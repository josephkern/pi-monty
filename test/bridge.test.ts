import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CodeRunner, renderToolStub } from '../src/index.js'
import type { HostTool } from '../src/index.js'
import { createPiBridgeTools } from '../src/pi/bridge.js'

let cwd: string
let tools: HostTool[]

function tool(name: string): HostTool {
  const found = tools.find((t) => t.name === name)
  if (!found) throw new Error(`missing bridged tool ${name}`)
  return found
}

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'bridge-test-'))
  await writeFile(join(cwd, 'notes.txt'), 'alpha\nbeta TODO fix\ngamma\n')
  await writeFile(join(cwd, 'data.txt'), 'one TODO two\n')
  tools = createPiBridgeTools(cwd)
})

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true })
})

describe('createPiBridgeTools', () => {
  it('bridges the full toolset with mutating tools gated', () => {
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    for (const name of ['read', 'grep', 'find', 'ls']) {
      expect(byName[name], name).toBeDefined()
      expect(byName[name].requiresApproval ?? false, name).toBe(false)
    }
    for (const name of ['bash', 'edit', 'write']) {
      expect(byName[name], name).toBeDefined()
      expect(byName[name].requiresApproval, name).toBe(true)
    }
  })

  it('converts Typebox schemas to Python params and documents return formats', () => {
    const read = tool('read')
    const path = read.params.find((p) => p.name === 'path')
    expect(path).toMatchObject({ type: 'str', optional: false })
    expect(read.params.length).toBeGreaterThan(1) // offset/limit etc.
    expect(read.returns).toBe('str')
    expect(read.returnsDescription).toContain('file contents')

    const grep = tool('grep')
    expect(grep.returnsDescription).toContain('matching lines')
    expect(renderToolStub(grep)).toContain('Returns:\n        str: newline-delimited matching lines')
  })

  it('reads files through the bridged read tool', async () => {
    const out = (await tool('read').execute(['notes.txt'], {})) as string
    expect(out).toContain('beta TODO fix')
  })

  it('greps through the bridge with positional and keyword args', async () => {
    const out = (await tool('grep').execute(['TODO'], {})) as string
    expect(out).toContain('notes.txt')
    expect(out).toContain('data.txt')
  })

  it('composes bridged tools inside sandboxed Python', async () => {
    const runner = new CodeRunner({ tools })
    const result = await runner.run(
      `hits = grep("TODO")
files = sorted(set(l.split(":")[0] for l in hits.splitlines() if ":" in l))
print(files)
len(files)`,
    )
    expect(result.ok).toBe(true)
    expect(result.output).toBe(2)
    expect(result.calls.map((c) => c.tool)).toEqual(['grep'])
  })

  it('gates bridged write and applies it when approved', async () => {
    const runner = new CodeRunner({ tools })
    const denied = await runner.run('write("new.txt", "content")', {
      onApproval: () => false,
    })
    expect(denied.ok).toBe(false)
    expect(denied.error).toContain('PermissionError')

    const approved = await runner.run('write("new.txt", "content")', {
      onApproval: () => true,
    })
    expect(approved.ok).toBe(true)
    expect(await readFile(join(cwd, 'new.txt'), 'utf8')).toBe('content')
  })

  it('maps pi tool failures to catchable Python exceptions', async () => {
    const runner = new CodeRunner({ tools })
    const result = await runner.run(
      'try:\n    read("missing.txt")\n    msg = "read"\nexcept RuntimeError as e:\n    msg = "failed"\nmsg',
    )
    expect(result.ok).toBe(true)
    expect(result.output).toBe('failed')
  })
})
