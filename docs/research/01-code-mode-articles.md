# Code-mode reading notes

Sources:
- https://blog.cloudflare.com/code-mode/
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling
- https://www.anthropic.com/engineering/code-execution-with-mcp

## Cloudflare "Code Mode"

- Thesis: **LLMs are better at writing code that calls tools than at emitting tool-call
  tokens directly** — pretraining contains millions of real programs but only synthetic
  tool-call examples.
- Architecture: replace N tools with one "run code" meta-tool. MCP schemas are converted
  to a typed TypeScript API with doc comments; the model writes TS against it; code runs
  in a fresh V8 isolate per snippet.
- Security model: capability bindings. The sandbox has **no network access at all**; the
  only egress is pre-authorized RPC bindings to the harness. Credentials never enter the
  sandbox.
- Multi-step chains collapse into one model turn — intermediate results never re-enter
  context.

## Anthropic: Programmatic Tool Calling (API feature)

- Claude writes Python in a code-execution container; calls to client tools **pause**
  execution and surface as a normal `tool_use` block tagged with
  `caller: {type: "code_execution_20260120", tool_id}`; the client returns `tool_result`
  and execution **resumes**. Only final stdout reaches model context.
- Tools opt in via `allowed_callers` on the tool definition. Tools are exposed to the
  code as **async Python functions** (fan-out via `asyncio.gather`).
- Measured: +11% on agentic search benchmarks with 24% fewer input tokens; −38% billed
  input tokens on a 75-tool benchmark. BUT: sequential 1–2-call workflows got ~8% *more*
  expensive — fixed overhead means code mode pays off for fan-out/filtering workloads,
  not single calls.
- Practical details worth copying: document the tool's *output* format in its
  description (code must deserialize it); container/session lifecycle with ids and
  expiry; pause/resume protocol shape.

## Anthropic: Code execution with MCP

- Problem at scale: loading all tool definitions upfront costs ~150k tokens; intermediate
  results pass through context twice. Code-execution version of the same task: ~2k tokens
  (98.7% reduction).
- Design: present MCP servers as a **filesystem of typed modules** (`servers/<server>/<tool>.ts`),
  each wrapping `callMCPTool<T>(name, input)`. The agent explores the tree and imports
  only what it needs — **progressive disclosure** of tool definitions.
- Code filters data before it reaches context (10,000-row sheet → 5 logged rows).
- **Skills**: the agent saves working code as reusable functions in a `skills/` dir —
  the agent accretes its own higher-level toolbox over time. (This is our "ephemeral
  code tools" idea, named.)
- Privacy: the harness can tokenize PII at the tool bridge (`[EMAIL_1]`) so real values
  flow tool-to-tool but never enter model context.

## Shared design principles

1. One meta-tool ("run code"), N typed functions inside the sandbox.
2. Express tool contracts as real code artifacts (signatures + docstrings), not JSON Schema.
3. Intermediate results stay in the execution environment; only code-selected output
   (print/stdout) reaches the model.
4. Progressive disclosure of tool definitions for large catalogs.
5. Pause/resume bridge protocol when tools execute outside the sandbox.
6. Capability-based sandbox: deny-all egress, credentials stay in the harness, fresh
   cheap isolation per execution.
7. Async-parallel stubs where the executor supports fan-out (monty 0.0.18 exposes one
   pending external call at a time, so this repo's current bridge is sequential).
8. Persistent workspace → emergent skills (saved, reusable code tools).
9. Not free: route by workload shape; keep direct tool calling for sequential
   reasoning-dependent flows.
