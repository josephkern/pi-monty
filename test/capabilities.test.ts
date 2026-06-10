import { describe, expect, it } from 'vitest'
import { probeImportableModules } from '../src/index.js'

describe('probeImportableModules', () => {
  it('reports real interpreter capabilities', () => {
    const modules = probeImportableModules()
    expect(modules).toContain('json')
    expect(modules).toContain('re')
    expect(modules).toContain('pathlib')
    expect(modules).not.toContain('time') // not in monty 0.0.18
  })

  it('respects a custom candidate list', () => {
    expect(probeImportableModules(['json', 'definitely_not_a_module'])).toEqual(['json'])
  })
})

import { probeTypeCheckerGaps, renderPythonToolRules } from '../src/index.js'

describe('probeTypeCheckerGaps', () => {
  it('finds runtime names ty rejects', () => {
    const gaps = probeTypeCheckerGaps()
    expect(gaps).toContain('open') // known gap on monty 0.0.18
    expect(probeTypeCheckerGaps(['len'])).toEqual([]) // ty knows len
  })
})

describe('renderPythonToolRules', () => {
  it('drops importable modules from the blocked counterexamples', () => {
    const rules = renderPythonToolRules(['json', 'time'])
    expect(rules).toContain('ONLY these modules exist: json, time')
    expect(rules).not.toMatch(/e\.g\.[^\n]*time/)
    expect(rules).toMatch(/e\.g\.[^\n]*random/)
  })
})
