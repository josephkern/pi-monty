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

/**
 * Runtime names monty's bundled type checker historically didn't know
 * (verified gaps on 0.0.18). Each is probed before being declared, so the
 * workaround self-prunes once ty learns a name.
 */
const TY_GAP_CANDIDATES = [
  'open',
  'bytearray',
  'PermissionError',
  'FileNotFoundError',
  'IsADirectoryError',
  'NotADirectoryError',
]

/**
 * Names the interpreter provides at runtime that its type checker rejects as
 * unresolved. These need `name: Any = None` declarations in any typecheck
 * prefix so valid code isn't refused pre-execution.
 */
export function probeTypeCheckerGaps(candidates: string[] = TY_GAP_CANDIDATES): string[] {
  return candidates.filter((name) => {
    try {
      new Monty(name, { typeCheck: true })
      return false // ty resolves it; declaring it would shadow real checking
    } catch {
      return true
    }
  })
}
