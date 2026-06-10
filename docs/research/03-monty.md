# @pydantic/monty notes (v0.0.18, verified from the installed package)

Monty is a minimal, **sandboxed Python interpreter written in Rust** (by the Pydantic
team), built specifically to run agent-written code. Microsecond startup, no containers.
Deny-by-default: no filesystem, network, or OS access — the only ways out are host-provided
external functions, explicit directory mounts, and the print callback. MIT licensed.
Repo: https://github.com/pydantic/monty. Experimental (0.0.x) — API may churn.

## Core API (from `wrapper.d.ts`)

```ts
import { Monty, MontyRepl, runMontyAsync, MountDir } from '@pydantic/monty'

const m = new Monty('x + y', { inputs: ['x', 'y'], typeCheck: false })
m.run({ inputs: { x: 1, y: 2 } })            // sync; returns last expression
```

### External functions — the tool bridge

Three levels:

1. **Sync**: `m.run({ externalFunctions: { add: (a, b) => a + b } })`
2. **Async**: `runMontyAsync(m, { externalFunctions: { fetch_data: async (u) => ... },
   printCallback: (stream, text) => ..., limits, mount, inputs })` — sandboxed Python can
   `await fetch_data(url)`.
3. **Pause/resume state machine** (what runMontyAsync is built on):

```ts
let p = m.start()
// p is MontySnapshot (paused at external call: .functionName, .args, .kwargs)
//   | MontyNameLookup (paused at unknown name: .variableName)
//   | MontyComplete  (.output)
p = p.resume({ returnValue: 10 })          // or { exception: { type, message } }
```

Unknown names surface as `MontyNameLookup` — resolve with `.resume({value})` or omit
value to raise `NameError`. This is literally Anthropic's programmatic-tool-calling
pause/resume protocol, in-process.

### Gotchas (verified empirically on 0.0.18, see `examples/smoke.ts`)

- `runMontyAsync` calls handlers as `(...args, kwargsObject)` — a kwargs object is
  always appended, even when empty.
- **No `await` in sandboxed Python**: external function calls are synchronous from
  Python's perspective (the pause/resume bridge does the async work host-side).
  `await get_temp(x)` fails with `TypeError: 'int' object can't be awaited` because
  resume injects a plain value. The `await` example in wrapper.d.ts JSDoc is wrong for
  this version.
- **`printCallback` must return `undefined`** — the NAPI layer raises
  `TypeError: Value is not undefined` on any other return value (e.g. `arr.push(...)`
  returns a number). Wrap in a block body.
- **Aliased tool calls dispatch by the JS function's `name`**: when a `MontyNameLookup`
  is resumed with a JS function value, later calls through that value pause as snapshots
  whose `functionName` is the JS function's `.name` (an anonymous arrow yields `''`).
  Resume lookups with a placeholder named after the tool and `f = double; f(2)` works.
- **Last-expression output is module-level only**: an expression at the end of an
  `except`/`if` block returns `null`; the result must be a top-level expression.
- **`MontyRepl.feed()` supports neither external functions nor printCallback** — native
  `FeedOptions` has only `mount`. REPL sessions therefore can't call host tools; our
  `Session` replays the transcript with a tool-call cache instead. Revisit when monty
  extends FeedOptions.
- `dir()` is not among the supported builtins.
- **Type-check prefix rules** (`typeCheckPrefixCode`): stub bodies must `raise` (`...`
  bodies trip ty's empty-body rule); optional params can't default to `...` outside
  .pyi files (use `| None = None`); declared `inputs` are unknown to ty; and ty's
  builtins model lacks several runtime names — `open`, `bytearray`,
  `PermissionError`, `FileNotFoundError`, `IsADirectoryError`, `NotADirectoryError` —
  all of which we declare as `Any` in the prefix. With typeCheck on, parse errors
  surface as `MontyTypingError` `invalid-syntax` diagnostics, not `MontySyntaxError`.
- **Mounts**: `open()`, `with`, `.read()/.readlines()`, and `pathlib.Path.read_text()`
  work; file objects are NOT iterable, `json.load` is missing (use
  `json.loads(text)`), and `os.listdir`/`os.walk` don't exist. Read-only mode blocks
  writes, symlink escapes, and `..` traversal (all verified). Constructing a
  `MountDir` canonicalizes the host path and **throws if it doesn't exist**.
- **A MountDir can't be attached to two runs at once** — a suspended run (paused at
  a host call) still holds its mount; a nested run reusing the same instance fails
  with `RuntimeError: mount 0 is already in use by another run`. Construct a fresh
  MountDir for nested/concurrent runs.
- **Definition order matters**: a function body can only resolve module-level names
  defined *before* the function's own `def` (verified: `def a(): return b()` then
  `def b(): ...` defines fine but `a()` raises NameError). Concatenating definitions
  in arbitrary order is unsafe; load-and-retry effectively topo-sorts.
- **"OS functions" are quarantined by design**: `datetime.now()`, `os.environ`,
  `time`, `random` raise (`not implemented with standard execution`) — monty keeps
  the interpreter deterministic; nondeterminism must come through host functions.
- **`runMontyAsync` masks runtime errors**: `snapshot.resume({returnValue})` sits inside
  its `try`, so a genuine `MontyRuntimeError` raised by subsequent Python code is caught
  and re-injected into the already-consumed snapshot, surfacing as the cryptic
  `Invalid exception type: 'MontyRuntimeError'`. Our runner must own the pause/resume
  loop instead of using `runMontyAsync`.

### State, persistence, REPL

- `MontyRepl` — incremental no-replay REPL: `repl.feed(code)` executes snippets against a
  **persistent heap + namespace** (smolagents-style step persistence).
- Everything serializes to bytes: `Monty.dump/load` (parsed code), `MontySnapshot.dump/load`
  (paused execution — resumable *in a different process*; durable-execution style),
  `MontyRepl.dump/load` (whole session state).

### Limits and safety

```ts
limits: { maxAllocations, maxDurationSecs, maxMemory, maxRecursionDepth /*default 1000*/, gcInterval }
```

- `MountDir(virtualPath, hostPath, { mode: 'read-only'|'read-write'|'overlay', writeBytesLimit })`
  — overlay (default) captures writes in memory.
- Errors: `MontySyntaxError`, `MontyRuntimeError` (`.traceback()` with real frames),
  `MontyTypingError` (`.displayDiagnostics()` — static type checking via `ty`).

## Language coverage

Supports a reasonable Python subset: functions, exceptions/tracebacks, kwargs, f-strings,
async/await of external functions, comprehensions. **Importable modules (probed on
0.0.18)**: `json`, `re`, `datetime`, `math`, `os`, `sys`, `typing`, `asyncio`,
`pathlib` — and nothing else (`time`, `random`, `collections`, `itertools`, etc. all
raise ModuleNotFoundError; ty also flags them pre-execution as `unresolved-import`).
We probe at extension startup (`probeImportableModules`) and render the live list into
the prompt. **Not yet**: class definitions, match statements, third-party packages.
One pending external call at a time (no in-VM parallel tool calls).

## Implications for our design

- The `MontySnapshot`/`MontyNameLookup` loop lets us intercept every tool call with full
  control (logging, permissions, exceptions back into Python).
- `MontyRepl.dump()` per pi session gives durable, branch-safe namespace persistence.
- Type checking pre-execution (`typeCheckPrefixCode` with our tool stubs) can reject bad
  code before running it and return `ty` diagnostics to the model.
- No classes/match yet → keep generated-code expectations modest; say so in the prompt.
