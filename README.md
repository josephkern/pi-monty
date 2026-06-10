# pi-monty

A code-mode meta-tool for agent harnesses: the agent writes sandboxed Python (via
[@pydantic/monty](https://github.com/pydantic/monty)) that calls host tools as plain
functions — and can save working code as named, reusable ephemeral tools. First target
harness: [pi](https://pi.dev).

- **Plan**: [PLAN.md](PLAN.md) — M0–M5 (MVP) complete
- **Research notes**: [docs/research/](docs/research/)

## Install (as a pi package)

```bash
pi install npm:pi-monty        # once published to npm
pi install /path/to/checkout   # or straight from a local clone (builds dist/ first: npm run build)
```

`@pydantic/monty` (including its platform-specific native binary) and `typebox` are
regular npm `dependencies`, so pi's installer pulls them in automatically;
`@earendil-works/pi-coding-agent` is a peer dependency satisfied by pi itself.

## Why

LLMs compose code better than they compose chained JSON tool calls: loops, filtering,
and aggregation happen inside the sandbox, and intermediate data never enters model
context — only what the code `print()`s. See `docs/research/01-code-mode-articles.md`
for the evidence (Cloudflare Code Mode, Anthropic programmatic tool calling, smolagents).

## Use with pi (development)

```bash
pi -e src/pi/extension.ts        # load straight from source, no build needed
```

This registers a `python` tool. The model gets the built-in host tools (`read_file`,
`list_files` rooted at the workspace, `http_get` host-side) rendered as Python stubs,
plus `save_tool`/`delete_tool`/`list_saved_tools`/`read_tool` for building its own
toolbox in `.pi/code-tools/*.py` (plain, user-editable Python files that auto-load
into future sessions). Variables persist across calls; state rides in tool-result
`details`, so it survives session restore and branching.

Custom host tools:

```ts
import { createPythonExtension } from './src/pi/extension.js'

export default createPythonExtension({
  tools: [
    {
      name: 'query_db',
      description: 'Run a read-only SQL query.',
      params: [{ name: 'sql', type: 'str' }],
      returns: 'list[dict]',
      returnsDescription: 'rows as dicts',
      execute: async ([sql]) => db.query(String(sql)),
    },
  ],
})
```

## Use as a library

```ts
import { CodeRunner, Session, ToolRegistry, createBuiltinTools } from './src/index.js'

const runner = new CodeRunner({ tools: createBuiltinTools({ root: process.cwd() }) })
const result = await runner.run('len(list_files("."))')
// result: { ok, output, stdout, error?, calls }
```

`Session` adds persistent state across runs (replay with a tool-call cache — earlier
side effects never repeat). `ToolStore` adds the saved-tools layer.

## Develop

```bash
npm install
npm test            # vitest (52 tests)
npm run typecheck
npm run smoke       # verifies monty primitives on your machine
npx tsx examples/demo.ts
```

## Architecture

```
src/core/    runner.ts    CodeRunner: owns monty's start/resume loop; tool dispatch,
                          tracebacks, limits, abort, per-call traces
             registry.ts  ToolRegistry + Python stub rendering + prompt rules
             builtins.ts  read_file / list_files / http_get starter tools
             session.ts   Persistent state via transcript replay + tool-call cache
             toolstore.ts Agent-saved tools as plain .py files + manage-from-sandbox
src/pi/      extension.ts pi adapter: `python` tool, streaming output, branch-safe state
```

Known monty 0.0.18 quirks we code around are documented in
[docs/research/03-monty.md](docs/research/03-monty.md).
