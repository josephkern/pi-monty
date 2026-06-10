# pi.dev extension/tool API notes

Source: https://pi.dev/docs/latest/extensions — repo: https://github.com/earendil-works/pi
(npm: `@earendil-works/pi-coding-agent`). pi is a minimal, heavily extensible coding
agent harness (Node, TypeScript extensions loaded via jiti, no compile step).

## Extension discovery

- `~/.pi/agent/extensions/*.ts` or `*/index.ts` (global)
- `.pi/extensions/*.ts` or `*/index.ts` (project-local)
- `pi -e ./my-extension.ts` for development; `extensions` array in settings.json.

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
  This survives session restore *and branching* — important for our REPL-state design.
- Events: `pi.on("session_start" | "tool_call" | "tool_result", handler)` — `tool_call`
  can mutate `event.input`; `tool_result` can rewrite results.
- `prepareArguments(args)` hook for schema migration on resumed sessions.
- `withFileMutationQueue(path, fn)` serializes file mutations.

## Implications for our design

- Our code tool is a single `pi.registerTool({ name: "code", ... })` extension.
- Streamed `print()` output → `onUpdate`; final result → `content`; REPL state pointer
  (or the serialized bytes/path) → `details` for branch-safe restore.
- AbortSignal maps to monty's `maxDurationSecs` plus a host-side kill between resumes.
- Ship as a pi package later (`pi.dev/packages`) bundling extension + skills + prompts.
