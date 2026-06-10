import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Session, ToolStore } from '../src/index.js'
import { createPythonExtension } from '../src/pi/extension.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'multi-tool-store-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const SHOUT = 'def shout(text):\n    return text.upper() + "!"\n'

describe('ToolStore', () => {
  it('saves tools as plain .py files with a description header', async () => {
    const store = new ToolStore(dir)
    await store.save('shout', SHOUT, 'Uppercase with a bang.')
    expect(await readFile(join(dir, 'shout.py'), 'utf8')).toBe(
      '# Uppercase with a bang.\n' + SHOUT,
    )
    expect(await store.list()).toEqual([
      { name: 'shout', description: 'Uppercase with a bang.', code: SHOUT },
    ])
  })

  it('rejects invalid names, syntax errors, and missing defs', async () => {
    const store = new ToolStore(dir)
    await expect(store.save('not valid', SHOUT, 'd')).rejects.toMatchObject({
      pythonType: 'ValueError',
    })
    await expect(store.save('shout', 'def shout(:', 'd')).rejects.toMatchObject({
      pythonType: 'ValueError',
    })
    await expect(store.save('shout', 'def other():\n    pass', 'd')).rejects.toMatchObject({
      pythonType: 'ValueError',
    })
  })

  it('deletes and reads back tools', async () => {
    const store = new ToolStore(dir)
    await store.save('shout', SHOUT, 'd')
    expect((await store.get('shout'))?.code).toBe(SHOUT)
    expect(await store.delete('shout')).toBe(true)
    expect(await store.delete('shout')).toBe(false)
    expect(await store.list()).toEqual([])
  })

  it('exposes host tools that manage the store from inside the sandbox', async () => {
    const store = new ToolStore(dir)
    const session = new Session({ tools: store.hostTools(() => false) })

    const saved = await session.run(
      `code = 'def shout(text):\\n    return text.upper() + "!"'
save_tool("shout", code, "Uppercase with a bang.")`,
    )
    expect(saved.ok).toBe(true)
    expect((await store.list()).map((t) => t.name)).toEqual(['shout'])

    const listed = await session.run('[t["name"] for t in list_saved_tools()]')
    expect(listed.output).toEqual(['shout'])
    const read = await session.run('read_tool("shout")')
    expect(read.output).toContain('def shout(text):')
  })

  it('refuses to shadow reserved host tool names', async () => {
    const store = new ToolStore(dir)
    const session = new Session({ tools: store.hostTools((name) => name === 'read_file') })
    const result = await session.run('save_tool("read_file", "def read_file():\\n    pass", "d")')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('built-in tool name')
  })
})

describe('saved tools through the pi extension', () => {
  it('auto-loads saved tools into fresh sessions and lists them in the description', async () => {
    // Session A: agent saves a tool.
    const a = await makeExtensionTool({ toolStore: dir })
    await a.execute('t1', {
      code: `save_tool("shout", 'def shout(text):\\n    return text.upper() + "!"', "Uppercase with a bang.")`,
    })

    // Session B (new process, same store): tool is in the prompt and callable.
    const b = await makeExtensionTool({ toolStore: dir })
    expect(b.description).toContain('shout: Uppercase with a bang.')
    const result = await b.execute('t2', { code: 'shout("hi")' })
    expect(result.content[0].text).toBe('=> "HI!"')
  })

  it('skips a malformed saved-tool file without losing the others', async () => {
    // simulate an agent writing files directly instead of using save_tool
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'broken.py'), '# Bad tool.\ndef broken(:\n')
    await writeFile(join(dir, 'shout.py'), '# Good tool.\ndef shout(t):\n    return t.upper()\n')

    const tool = await makeExtensionTool({ toolStore: dir })
    const result = await tool.execute('t1', { code: 'shout("ok")' })
    expect(result.content[0].text).toContain('skipped saved tool(s)')
    expect(result.content[0].text).toContain('broken')
    expect(result.content[0].text).toContain('=> "OK"')
  })

  it('loads saved tools that depend on later-sorting tools via the retry pass', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'a_user.py'), '# Uses z_helper.\ndef a_user(x):\n    return z_helper(x) + 1\n')
    await writeFile(join(dir, 'z_helper.py'), '# Helper.\ndef z_helper(x):\n    return x * 10\n')

    const tool = await makeExtensionTool({ toolStore: dir })
    const result = await tool.execute('t1', { code: 'a_user(4)' })
    expect(result.content[0].text).toBe('=> 41')
  })

  it('reset reloads tools saved earlier in the same session', async () => {
    const tool = await makeExtensionTool({ toolStore: dir })
    await tool.execute('t1', {
      code: `save_tool("shout", 'def shout(text):\\n    return text.upper() + "!"', "d")`,
    })
    const result = await tool.execute('t2', { code: 'shout("now")', reset: true })
    expect(result.content[0].text).toBe('=> "NOW!"')
  })

  async function makeExtensionTool(options: Parameters<typeof createPythonExtension>[0]) {
    const tools: {
      description: string
      execute: (
        id: string,
        params: { code: string; reset?: boolean },
      ) => Promise<{ content: { text: string }[] }>
    }[] = []
    await createPythonExtension({ noBuiltins: true, ...options })({
      registerTool: (t: unknown) => tools.push(t as (typeof tools)[number]),
      on: () => {},
    } as never)
    return tools[0]
  }
})
