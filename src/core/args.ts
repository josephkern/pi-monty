import { HostToolError } from './types.js'

/** Positional-or-keyword argument lookup, Python-style. */
export function arg(
  args: unknown[],
  kwargs: Record<string, unknown>,
  index: number,
  name: string,
): unknown {
  if (index < args.length && name in kwargs) {
    throw new HostToolError(`got multiple values for argument '${name}'`, 'TypeError')
  }
  return index < args.length ? args[index] : kwargs[name]
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new HostToolError(`argument '${name}' must be a str`, 'TypeError')
  }
  return value
}
