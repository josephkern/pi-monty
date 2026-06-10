import { Monty } from '@pydantic/monty'

/**
 * Stdlib modules worth probing — common agent-code imports. Monty supports a
 * small (growing) subset; everything else raises ModuleNotFoundError.
 */
const CANDIDATE_MODULES = [
  'json',
  're',
  'datetime',
  'math',
  'os',
  'sys',
  'typing',
  'asyncio',
  'pathlib',
  'time',
  'random',
  'collections',
  'itertools',
  'functools',
  'string',
  'textwrap',
  'base64',
  'hashlib',
  'statistics',
  'io',
  'copy',
  'enum',
  'dataclasses',
  'uuid',
  'csv',
  'urllib',
]

/**
 * Empirically determines which modules the installed monty can import, by
 * trying each in a throwaway interpreter (microseconds apiece). Probing the
 * runtime keeps the prompt truthful across monty upgrades.
 */
export function probeImportableModules(candidates: string[] = CANDIDATE_MODULES): string[] {
  return candidates.filter((name) => {
    try {
      new Monty(`import ${name}`).run()
      return true
    } catch {
      return false
    }
  })
}
