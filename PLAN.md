# multi-tool — MVP plan

A general-purpose **code-mode tool** for agent harnesses (first target: [pi](https://pi.dev)),
backed by [@pydantic/monty](https://github.com/pydantic/monty)'s sandboxed Python
interpreter. The agent gets one meta-tool — *run Python* — in which host tools appear as
plain Python functions, and can **save working code as named, reusable ephemeral tools**
that persist across runs and sessions.

Research behind this design: `docs/research/` (Cloudflare Code Mode, Anthropic
programmatic tool calling + code-execution-with-MCP, smolagents, monty API, pi extension
API).

## Why this shape

- LLMs compose code better than they compose chained tool calls; loops/conditionals/
  filtering happen in the sandbox and intermediate data never enters model context.
- monty gives us the hard part for free, in-process, no containers: deny-all sandbox,
  pause/resume interception of every tool call, resource limits, real tracebacks,
  serializable session state (`MontyRepl.dump()`), and even cross-process resumable
  snapshots (future: human-approval gates mid-execution).
- pi's `registerTool` extension API is a thin, clean host: streaming updates, session
  `details` for branch-safe state, project-local auto-discovery.

## Architecture

```
src/
├── core/                    # harness-agnostic library
│   ├── types.ts             # HostTool, RunResult, ToolCallTrace, limits config
│   ├── registry.ts          # ToolRegistry: host tools + prompt rendering (Python stubs)
│   ├── runner.ts            # CodeRunner: owns the start/resume loop (NOT runMontyAsync)
│   ├── session.ts           # Session: MontyRepl state, dump/load, injected variables
│   └── toolstore.ts         # Ephemeral tools: save/list/load named Python functions
├── pi/
│   └── extension.ts         # pi adapter: registerTool("python", ...)
└── index.ts
examples/                    # standalone demos (no pi required)
```

### Core contracts

```ts
interface HostTool {
  name: string                 // python identifier
  description: string          // becomes the docstring
  params: { name: string; type: string; description?: string; optional?: boolean }[]
  returns: string              // python type + shape description (code must deserialize!)
  execute(args: unknown[], kwargs: Record<string, unknown>): Promise<unknown>
}

interface RunResult {
  ok: boolean
  output: unknown              // last-expression value
  stdout: string               // print() observation channel
  error?: string               // formatted Python traceback (model-facing)
  calls: ToolCallTrace[]       // every host-tool call: name, args, duration, result size
}
```

`CodeRunner` implements the `start()` → `MontySnapshot | MontyNameLookup | MontyComplete`
loop itself because of the `runMontyAsync` error-masking bug (docs/research/03-monty.md).
Owning the loop also gives us: per-call hooks (logging, permission checks, PII filtering
later), proper AbortSignal handling between resumes, and exception injection back into
Python (`resume({exception})`) when a host tool fails — so the model sees a Python
exception it can handle, not a dead run.

### Prompt rendering

The registry renders registered tools as Python stubs (what the model sees in the tool
description / promptSnippet):

```python
def read_file(path: str) -> str:
    """Read a project file. Returns the file text."""

def http_get(url: str) -> str:
    """GET a URL. Returns the response body as text."""
```

Rules baked into the prompt (from smolagents/monty findings): call tools *without*
`await`; use `print()` to surface what you need to see; state persists between runs;
no classes/match statements; last expression is the result.

## Milestones

### M0 — Scaffolding & research ✅ (this commit)
git repo, TypeScript + tsx, @pydantic/monty installed, research notes, smoke test
verifying external functions, pause/resume, REPL dump/load, tracebacks, limits.

### M1 — CodeRunner (core loop) ✅
- start/resume loop with external-function dispatch (sync + async host tools),
  including calls through aliases (named-placeholder trick, docs/research/03-monty.md)
- stdout capture (capped), last-expression output, formatted tracebacks on error
- resource limits (defaults: 5s, 64MB), AbortSignal checked between resumes
- host-tool errors injected as Python exceptions (`HostToolError` picks the Python
  exception type); call trace collection
- vitest suite (17 tests) covering happy paths + error paths

### M2 — ToolRegistry + prompt rendering ✅
- `ToolRegistry` with name collision/identifier validation; `CodeRunner` delegates to it
- Python stub + docstring rendering (`renderToolStub`, `PYTHON_TOOL_RULES`)
- starter built-ins (`createBuiltinTools`): `read_file`/`list_files` rooted at a
  workspace dir (traversal- and symlink-escape-proof), `http_get` (host-side fetch —
  credentials stay outside the sandbox); Python-style positional-or-keyword args

### M3 — Sessions ✅
- `MontyRepl` turned out unusable here: `feed()` supports neither external functions
  nor printCallback (0.0.18). `Session` instead **replays** the transcript of
  successful snippets in a fresh interpreter per run, serving prior host-tool calls
  from a recorded cache (no repeated side effects); failed snippets roll back fully
- per-run results show only the new stdout and new tool calls
- `dump()/load()` is plain JSON — human-readable and branch-safe for pi `details`
- inputs persist across snippets (smolagents `additional_args` pattern)
- caveats: non-deterministic code (e.g. `datetime.now()`) can diverge on replay;
  replay cost grows with transcript length (monty is fast; fine at session scale)

### M4 — pi extension (MVP ships here)
- `src/pi/extension.ts` registering a `python` tool (Typebox params: `{ code }`)
- streaming `print()` output via `onUpdate`; `truncateHead` on final output
- session state restored from tool-result `details` on `session_start` (branch-safe:
  replay saved code definitions rather than raw heap bytes where possible)
- install instructions: symlink/copy into `.pi/extensions/` or `pi -e`

### M5 — Ephemeral code tools ("skills")
The general-purpose payoff: the agent builds its own toolbox.
- `save_tool(name, code, description)` host function — validates the code defines
  `name`, stores `{name, description, code}` in a project-local store
  (`.pi/code-tools/*.py` + manifest)
- saved tools are auto-fed into every new session and listed in the prompt under
  "your saved tools"; `list_tools()` / `read_tool(name)` for progressive disclosure
- delete/overwrite semantics; tools are plain Python files — user-inspectable and
  -editable

## Post-MVP directions

- **Progressive disclosure at scale**: `search_tools(query, detail_level)` instead of
  rendering all stubs (Anthropic MCP-article pattern) once tool count grows
- **Bridge pi's own tools / MCP servers** into the registry automatically (the
  Cloudflare conversion pattern: schema → typed stub)
- **Type-check gate**: `typeCheckPrefixCode` with generated stubs to reject bad code
  pre-execution and return `ty` diagnostics to the model
- **Approval gates**: serialize the `MontySnapshot` at a sensitive call, ask the user,
  resume — durable human-in-the-loop mid-script
- **PII tokenization** at the bridge boundary
- Publish as a pi package (`pi.dev/packages`) and as a standalone npm library

## Known constraints / risks

- monty is 0.0.x and experimental: no classes or match statements yet, small stdlib
  whitelist, one pending external call at a time (no in-VM parallel fan-out), API may
  churn. Pin the version; keep the runner thin so swapping executors stays possible.
- Verified quirks we code around (details in docs/research/03-monty.md): no `await` on
  external calls, `printCallback` must return `undefined`, `runMontyAsync` masks errors
  (we own the loop).
- Code-mode has fixed overhead — for single sequential calls it's a net loss (Anthropic
  measured ~8% cost increase on that shape). The `python` tool complements pi's direct
  tools; it doesn't replace them.
