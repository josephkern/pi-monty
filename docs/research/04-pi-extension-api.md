# pi.dev extension/tool API notes

Source: https://pi.dev/docs/latest/extensions — repo: https://github.com/earendil-works/pi
(npm: `@earendil-works/pi-coding-agent`). pi is a minimal, heavily extensible coding
agent harness (Node; TypeScript extensions can be loaded directly during development,
while npm packages usually ship built JavaScript).

## Extension discovery

- `~/.pi/agent/extensions/*.ts` or `*/index.ts` (global)
- `.pi/extensions/*.ts` or `*/index.ts` (project-local)
- `pi -e ./my-extension.ts` for development; `extensions` array in settings.json.
- npm packages can advertise extension entrypoints with a package.json `pi.extensions`
  array. This repo ships `extensions/index.js`, which re-exports `dist/pi/extension.js`.

## Shape

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "What this tool does (shown to LLM)",
    promptSnippet: "One-line entry for Available tools section",
    promptGuidelines: ["Use my_tool when ..."],
    parameters: Type.Object({            // Typebox schemas
      action: Type.String(),
      text: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // signal: AbortSignal — check signal?.aborted
      // onUpdate?.({ content: [...], details: {...} })  // streaming progress
      return {
        content: [{ type: "text", text: "Output to LLM" }],
        details: { /* metadata persisted in session; survives branching */ },
      };
    },
  });
}
```

- Use `StringEnum` from `@earendil-works/pi-ai` for string enums (Google API compat).
- Throw to mark a tool call failed; returning never sets the error flag.
- Truncation helpers: `truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES })`
  (defaults 50KB / 2000 lines) — tools are responsible for their own truncation.

## State across a session

- Persist durable data in the tool result's `details`; on `session_start`, walk
  `ctx.sessionManager.getBranch()` and rebuild in-memory state from past tool results.
  This survives session restore *and branching* — important for our serialized
  `Session.dump()` replay state.
- Events: `pi.on("session_start" | "tool_call" | "tool_result", handler)` — `tool_call`
  can mutate `event.input`; `tool_result` can rewrite results.
- `prepareArguments(args)` hook for schema migration on resumed sessions.
- `withFileMutationQueue(path, fn)` serializes file mutations.

## Implications for our design

- Our code tool is a single `pi.registerTool({ name: "code", ... })` extension.
- Streamed `print()` output → `onUpdate`; final result → `content`; serialized
  `Session.dump()` JSON → `details` for branch-safe restore.
- AbortSignal maps to monty's `maxDurationSecs` plus a host-side kill between resumes.
- The npm package is a pi package (`pi-package` keyword + `pi.extensions`) whose default
  extension registers the `code` tool; custom projects can still re-export
  `createPythonExtension(options)` from their own `.pi/extensions/*.ts` file.
