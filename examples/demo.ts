/**
 * Standalone demo (no pi required): a session with the built-in tools where
 * "the agent" explores the workspace, computes, saves a reusable tool, and a
 * second session uses it.
 *
 *   npx tsx examples/demo.ts
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, ToolRegistry, ToolStore, createBuiltinTools } from '../src/index.js'

const storeDir = await mkdtemp(join(tmpdir(), 'demo-code-tools-'))
const store = new ToolStore(storeDir)

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry(createBuiltinTools({ root: process.cwd() }))
  for (const tool of store.hostTools((name) => registry.has(name))) registry.add(tool)
  return registry
}

// Session 1: explore, compute, save a reusable tool.
const first = new Session({ tools: makeRegistry() })
const explore = await first.run(`
entries = list_files(".")
py_files = [f for f in entries if f.endswith(".ts")]
print(f"{len(entries)} entries, {len(py_files)} TypeScript files at top level")

code = '''
def count_lines(path):
    return len(read_file(path).splitlines())
'''
save_tool("count_lines", code, "Count lines in a workspace file.")
`)
console.log('session 1 stdout:', explore.stdout.trim())
console.log('session 1 tool calls:', explore.calls.map((c) => c.tool).join(', '))

// Session 2: fresh namespace; the saved tool loads from the store's prelude.
const second = new Session({ tools: makeRegistry() })
await second.run(await store.prelude())
const use = await second.run('count_lines("package.json")')
console.log('session 2: package.json has', use.output, 'lines')

await rm(storeDir, { recursive: true, force: true })
