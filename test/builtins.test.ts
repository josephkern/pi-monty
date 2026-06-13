import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CodeRunner, createBuiltinTools } from '../src/index.js'
import type { HostTool } from '../src/index.js'

let root: string
let outside: string
let tools: HostTool[]

function tool(name: string): HostTool {
  const found = tools.find((t) => t.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'multi-tool-root-'))
  outside = await mkdtemp(join(tmpdir(), 'multi-tool-outside-'))
  await writeFile(join(root, 'hello.txt'), 'hello world\n')
  await mkdir(join(root, 'sub'))
  await writeFile(join(root, 'sub', 'nested.txt'), 'nested')
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await symlink(join(outside, 'secret.txt'), join(root, 'sneaky.txt'))
  tools = createBuiltinTools({ root })
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('read_file', () => {
  it('reads files by positional or keyword arg', async () => {
    expect(await tool('read_file').execute(['hello.txt'], {})).toBe('hello world\n')
    expect(await tool('read_file').execute([], { path: 'sub/nested.txt' })).toBe('nested')
  })

  it('truncates beyond maxFileBytes', async () => {
    const small = createBuiltinTools({ root, maxFileBytes: 5 })
    const text = (await small[0].execute(['hello.txt'], {})) as string
    expect(text).toBe('hello\n[...truncated]')
  })

  it('raises FileNotFoundError for missing files', async () => {
    await expect(tool('read_file').execute(['nope.txt'], {})).rejects.toMatchObject({
      pythonType: 'FileNotFoundError',
    })
  })

  it('raises PermissionError on traversal, absolute paths, and symlink escapes', async () => {
    await expect(tool('read_file').execute(['../escape.txt'], {})).rejects.toMatchObject({
      pythonType: 'PermissionError',
    })
    await expect(tool('read_file').execute(['/etc/passwd'], {})).rejects.toMatchObject({
      pythonType: 'PermissionError',
    })
    await expect(tool('read_file').execute(['sneaky.txt'], {})).rejects.toMatchObject({
      pythonType: 'PermissionError',
    })
  })

  it('raises IsADirectoryError for directories', async () => {
    await expect(tool('read_file').execute(['sub'], {})).rejects.toMatchObject({
      pythonType: 'IsADirectoryError',
    })
  })
})

describe('list_files', () => {
  it('lists the root by default with trailing slash on dirs', async () => {
    expect(await tool('list_files').execute([], {})).toEqual(['hello.txt', 'sneaky.txt', 'sub/'])
  })

  it('raises NotADirectoryError for files', async () => {
    await expect(tool('list_files').execute(['hello.txt'], {})).rejects.toMatchObject({
      pythonType: 'NotADirectoryError',
    })
  })
})

describe('http_get', () => {
  const fakeFetch = (async (url: unknown) => {
    if (String(url).includes('missing')) return new Response('nope', { status: 404 })
    return new Response(`body for ${url}`)
  }) as typeof fetch

  it('returns the body', async () => {
    const [, , httpGet] = createBuiltinTools({ root, fetchImpl: fakeFetch })
    expect(await httpGet.execute(['https://x.test/a'], {})).toBe('body for https://x.test/a')
  })

  it('truncates streaming responses without reading the whole body', async () => {
    let canceled = false
    const fakeStreamingFetch = (async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hello'))
          controller.enqueue(new TextEncoder().encode(' world'))
        },
        cancel() {
          canceled = true
        },
      })
      return new Response(stream)
    }) as typeof fetch
    const [, , httpGet] = createBuiltinTools({ root, fetchImpl: fakeStreamingFetch, maxHttpBytes: 5 })

    expect(await httpGet.execute(['https://x.test/large'], {})).toBe('hello\n[...truncated]')
    expect(canceled).toBe(true)
  })

  it('raises OSError on HTTP errors and ValueError on bad schemes', async () => {
    const [, , httpGet] = createBuiltinTools({ root, fetchImpl: fakeFetch })
    await expect(httpGet.execute(['https://x.test/missing'], {})).rejects.toMatchObject({
      pythonType: 'OSError',
    })
    await expect(httpGet.execute(['file:///etc/passwd'], {})).rejects.toMatchObject({
      pythonType: 'ValueError',
    })
  })
})

describe('end to end through CodeRunner', () => {
  it('lets sandboxed Python explore and read the workspace', async () => {
    const runner = new CodeRunner({ tools })
    const result = await runner.run(
      `files = list_files()
texts = []
for f in files:
    if f.endswith(".txt"):
        try:
            texts.append(f + ": " + read_file(f).strip())
        except PermissionError:
            texts.append(f + ": <blocked>")
print("\\n".join(texts))
len(texts)`,
    )
    expect(result.status).toBe('ok')
    expect(result.stdout).toContain('hello.txt: hello world')
    expect(result.stdout).toContain('sneaky.txt: <blocked>')
    expect(result.output).toBe(2)
  })
})
