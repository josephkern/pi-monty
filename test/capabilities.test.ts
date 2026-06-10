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
