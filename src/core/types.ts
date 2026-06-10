import type { MountDir } from '@pydantic/monty'

/** A parameter of a host tool, described in Python terms for prompt rendering. */
export interface HostToolParam {
  /** Python identifier. */
  name: string
  /** Python type expression, e.g. 'str', 'int', 'list[str]'. */
  type: string
  description?: string
  optional?: boolean
}

/**
 * A host-side tool exposed to sandboxed Python as a plain function.
 *
 * `execute` runs on the host while the interpreter is paused; it may be sync or
 * async. Throw `HostToolError` to surface a specific Python exception type to the
 * sandboxed code; any other thrown error surfaces as `RuntimeError`.
 */
export interface HostTool {
  /** Python identifier the sandboxed code calls. */
  name: string
  /** Becomes the docstring in the rendered Python stub. */
  description: string
  params: HostToolParam[]
  /** Python type expression of the return value, e.g. 'str', 'list[dict]'. */
  returns: string
  /** Shape/meaning of the return value (the model's code must deserialize it). */
  returnsDescription?: string
  execute(args: unknown[], kwargs: Record<string, unknown>): unknown | Promise<unknown>
}

/** Thrown by host tools to raise a specific Python exception in the sandbox. */
export class HostToolError extends Error {
  /** Python exception type to raise, e.g. 'ValueError', 'FileNotFoundError'. */
  readonly pythonType: string

  constructor(message: string, pythonType = 'RuntimeError') {
    super(message)
    this.name = 'HostToolError'
    this.pythonType = pythonType
  }
}

/** One host-tool invocation made by the sandboxed code. */
export interface ToolCallTrace {
  tool: string
  args: unknown[]
  kwargs: Record<string, unknown>
  durationMs: number
  ok: boolean
  /** Host-side error message when ok is false (what was raised into Python). */
  error?: string
}

export interface RunLimits {
  /** Max VM execution time in seconds (host tool time not included). Default 5. */
  maxDurationSecs?: number
  /** Max heap memory in bytes. Default 64 MiB. */
  maxMemory?: number
  maxAllocations?: number
  maxRecursionDepth?: number
}

export interface RunOptions {
  /** Host variables injected into the code's namespace by name. */
  inputs?: Record<string, unknown>
  limits?: RunLimits
  /** Checked between interpreter resumes and after each host-tool call. */
  signal?: AbortSignal
  /** Filesystem mount(s) for the sandbox. */
  mount?: MountDir | MountDir[]
  /** Name shown in tracebacks. Default 'tool.py'. */
  scriptName?: string
  /** Cap on captured stdout bytes; output beyond it is dropped. Default 1 MiB. */
  maxStdoutBytes?: number
  /** Streaming observer for print() chunks, called as they happen (uncapped). */
  onPrint?: (text: string) => void
}

export interface RunResult {
  ok: boolean
  /** Value of the last expression (undefined on failure). */
  output: unknown
  /** Captured print() output — the model-facing observation channel. */
  stdout: string
  /** True if stdout exceeded maxStdoutBytes and was truncated. */
  stdoutTruncated: boolean
  /** Model-facing failure description (Python traceback, syntax error, abort notice). */
  error?: string
  /** Kind of failure, when ok is false. */
  errorKind?: 'syntax' | 'runtime' | 'typing' | 'aborted'
  /** Every host-tool call the code made, in order. */
  calls: ToolCallTrace[]
}
