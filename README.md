# multi-tool

A code-mode meta-tool for agent harnesses: the agent writes sandboxed Python (via
[@pydantic/monty](https://github.com/pydantic/monty)) that calls host tools as plain
functions — and can save working code as named, reusable ephemeral tools. First target
harness: [pi](https://pi.dev).

- **Plan**: [PLAN.md](PLAN.md)
- **Research notes**: [docs/research/](docs/research/)

## Status

M0 — scaffolding + research + verified monty smoke test.

```bash
npm install
npm run smoke   # exercises external functions, pause/resume, REPL persistence, tracebacks, limits
```
