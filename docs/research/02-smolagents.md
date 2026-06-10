# smolagents (HuggingFace) reading notes

Source: https://github.com/huggingface/smolagents + docs (v1.26).

## Why code-as-actions

Primary citation: CodeAct paper (arXiv 2402.01030) — code actions give up to ~20% higher
success and ~30% fewer steps than JSON tool calls. Qualitative wins: composability
(loops/conditionals/functions), object management between calls, generality, and heavy
representation in pretraining data.

Their honest tradeoff: code agents are less predictable, need error handling and a
secure executor. They recommend plain JSON tool calling when interactions are inherently
one-call-at-a-time.

## The CodeAgent loop (ReAct)

```
memory = [task]
while not done:
    code = llm(memory)          # "Thought: ..." + fenced python block
    result, logs = executor(code)
    memory += [code, logs/error]   # print() output is the observation channel
```

- Ends when generated code calls `final_answer(value)` (executor sets `is_final_answer`),
  or at `max_steps` (default 20, then a forced final-answer LLM call).
- **Executor namespace persists across steps** — variables/imports from step N are
  available in step N+1. This is the key differentiator vs stateless tool calls.
- `additional_args` injects host objects as named variables into the namespace.
- Errors (syntax, runtime, illegal import, timeout) are caught and fed back verbatim as
  observations — the ReAct loop *is* the retry mechanism. Tools should raise rich,
  instructive errors so the model can self-correct.

## Tool exposure

Each tool is rendered into the system prompt as a Python function stub with docstring
(`tool.to_code_prompt()`); the executor injects the real callable into the interpreter
namespace. Tools with an output schema get it included so the model can chain
`result['field']` confidently; without a schema, the prompt tells the model to print and
observe before chaining.

## Executors

`local` (AST-walking interpreter with import whitelist, op-count cap, timeout —
explicitly *not* a security boundary), `docker`, `e2b`, `modal`, `blaxel`. All return
`{output, logs, is_final_answer}`.

## Checklist for our design

- Pluggable executor behind `{output, logs, isFinalAnswer}`.
- Persistent namespace per session (monty's `MontyRepl` gives us this natively).
- print() as observation channel; truncate long output.
- Errors as first-class observations with tracebacks.
- `final_answer` sentinel + optional validators.
