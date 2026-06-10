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

## What you get

Installing registers a `code` tool. The workspace is **mounted read-only at
`/workspace`**, so code reads files with plain `open()`/`pathlib` (monty enforces
read-only mode, symlink-escape and `..`-traversal protection). Host tools
(`list_files`, `http_get` host-side) are rendered as Python stubs, plus
`save_tool`/`delete_tool`/`list_saved_tools`/`read_tool` for building a toolbox in
`.pi/code-tools/*.py` (plain, user-editable Python files that auto-load into future
sessions). Variables persist across calls; state rides in tool-result `details`, so
it survives session restore and branching.

Code is **statically type-checked before execution** (monty's bundled `ty`) against
typed stubs of every host tool — wrong argument types, bad methods on tool results,
and undefined names come back as compiler diagnostics *before any side effects run*,
instead of as tracebacks after three tool calls already happened.

## Example pi session

```text
$ pi
> Use the code tool to fetch https://api.github.com/repos/pydantic/monty,
  report the star count, and save a reusable tool gh_stars(repo) for next time.

  ● Code
    data = json.loads(http_get("https://api.github.com/repos/pydantic/monty"))
    print(f"stars: {data['stargazers_count']}")
    save_tool("gh_stars", '''
    def gh_stars(repo):
        return json.loads(http_get(f"https://api.github.com/repos/{repo}"))["stargazers_count"]
    ''', "Return the GitHub star count for owner/repo.")

pydantic/monty currently has 1,234 stars. I saved gh_stars(repo) for future use.
```

In a later session — no redefinition needed, `gh_stars` auto-loads:

```text
> how many stars does josephkern/pi-monty have?

  ● Code
    gh_stars("josephkern/pi-monty")
```

Because the work happens in one sandboxed snippet, intermediate data (the full API
response, loop iterations, file contents) never enters the model's context — only
what the code prints comes back.

## Configuration

The default export works out of the box. For custom host tools or a different tool
name, re-export from your own extension file (e.g. `.pi/extensions/code.ts`):

```ts
import { createPythonExtension } from 'pi-monty/pi'

export default createPythonExtension({
  toolName: 'code',              // rename if your model responds better to e.g. 'python'
  mountWorkspace: true,          // false: no /workspace mount, read_file tool instead
  typeCheck: true,               // false: skip the pre-execution type-check gate
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

## Develop against this repo

```bash
pi -e src/pi/extension.ts        # load straight from source, no build needed
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
npm test            # vitest (59 tests)
npm run typecheck
npm run smoke       # verifies monty primitives on your machine
npx tsx examples/demo.ts
```

## Architecture

```
src/core/    runner.ts    CodeRunner: owns monty's start/resume loop; tool dispatch,
                          tracebacks, limits, abort, per-call traces
             registry.ts  ToolRegistry + Python/typecheck stub rendering + prompt rules
             builtins.ts  read_file / list_files / http_get starter tools
             session.ts   Persistent state via transcript replay + tool-call cache
             toolstore.ts Agent-saved tools as plain .py files + manage-from-sandbox
src/pi/      extension.ts pi adapter: `code` tool (configurable name), streaming output, branch-safe state
```

Known monty 0.0.18 quirks we code around are documented in
[docs/research/03-monty.md](docs/research/03-monty.md).
