# pi-code-tool — MVP plan

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
│   └── extension.ts         # pi adapter: registerTool("code", ...)
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

### M4 — pi extension (MVP ships here) ✅
- `src/pi/extension.ts`: `createPythonExtension(options)` + default export;
  registers a `code` tool (name configurable; Typebox params `{ code, reset? }`) whose description
  embeds the rendered stubs + rules
- streaming `print()` output via `onUpdate` (new `onPrint` core option, replay-aware);
  `truncateHead` on final output; tracebacks returned as content (observation channel)
- session state rides in tool-result `details` (JSON dump) and is restored from
  `ctx.sessionManager.getBranch()` on `session_start` — branch-safe
- typechecked against the real `@earendil-works/pi-coding-agent` types; tested via a
  mock ExtensionAPI; run live with `pi -e src/pi/extension.ts`
- **live-verified 2026-06-10** with `pi --print -t python` against a local model:
  multi-step code-mode task (list_files + read_file + compute in one snippet), then
  the full M5 loop — agent wrote/tested/saved `slugify` via `save_tool`, and a fresh
  pi process auto-loaded and used it without defining it

### M5 — Ephemeral code tools ("skills") ✅
The general-purpose payoff: the agent builds its own toolbox.
- `save_tool(name, code, description)` host function — validates syntax (monty parse)
  and that the code defines `name`; stores plain `.py` files (first line
  `# <description>`) in `.pi/code-tools/` — user-inspectable and -editable
- saved tools auto-load into fresh sessions as a prelude and are listed in the tool
  description; `list_saved_tools()` / `read_tool(name)` / `delete_tool(name)` manage
  the store from inside the sandbox; reserved (host-tool) names can't be shadowed
- `reset=true` reloads saved tools mid-session; prelude failures degrade gracefully

## Post-MVP directions

- **Progressive disclosure at scale**: `search_tools(query, detail_level)` instead of
  rendering all stubs (Anthropic MCP-article pattern) once tool count grows
- ~~**Bridge pi's own tools**~~ ✅ shipped in 0.3.0: read/grep/find/ls bridged
  directly, bash/edit/write behind approval gates; Typebox schema → Python stub
  conversion in src/pi/bridge.ts (MCP servers still open — needs pi API support)
- ~~**Type-check gate**~~ ✅ shipped in 0.2.0: generated raising-body stubs as
  `typeCheckPrefixCode`; ty diagnostics returned pre-execution with adjusted line
  numbers; missing-runtime-builtin declarations (docs/research/03-monty.md)
- ~~**Workspace mount**~~ ✅ shipped in 0.2.0: read-only `/workspace` MountDir
  replaces the `read_file` host tool (monty enforces read-only + escape protection)
- ~~**Approval gates**~~ ✅ shipped in 0.3.0: `requiresApproval` host tools pause
  the script at the call (in-memory await; pi shows ctx.ui.confirm with the exact
  invocation); denial raises catchable PermissionError; replayed approvals never
  re-prompt. The *durable* form (serialize the MontySnapshot to disk, resume in a
  different process days later) remains open
- **PII tokenization** at the bridge boundary
- ~~Publish~~ ✅ on npm as `pi-code-tool` (pi.dev gallery via the pi-package keyword)

## Deferred from the 0.2.0 code review (post-MVP)

- mounted reads have no size cap (the 64 MiB heap limit is the backstop) and replay
  re-reads mounted files from disk — mutating a workspace file mid-session changes
  what earlier snippets see on replay
- ty re-checks the full replayed transcript on every run (linear ms-scale growth);
  fine at session scale, revisit with transcript compaction
- per-message session-state dumps grow pi session files O(n²) across a conversation
  (failed runs now reuse the last dump; delta encoding would fix the rest)
- saved-tool loading replays the session per file (O(N²) interpreter runs) — the
  price of correct dependency ordering; cache the post-prelude dump if it bites

## Known constraints / risks

- monty is 0.0.x and experimental: no classes or match statements yet, small stdlib
  whitelist, one pending external call at a time (no in-VM parallel fan-out), API may
  churn. Pin the version; keep the runner thin so swapping executors stays possible.
- Verified quirks we code around (details in docs/research/03-monty.md): no `await` on
  external calls, `printCallback` must return `undefined`, `runMontyAsync` masks errors
  (we own the loop).
- Code-mode has fixed overhead — for single sequential calls it's a net loss (Anthropic
  measured ~8% cost increase on that shape). The `code` tool complements pi's direct
  tools; it doesn't replace them.
