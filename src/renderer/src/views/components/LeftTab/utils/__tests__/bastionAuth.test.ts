import { describe, it, expect } from 'vitest'
import { resolveBastionAuthType, type BastionDefinitionSummary } from '../types'

describe('resolveBastionAuthType', () => {
  it('keeps password for jumpserver when current auth is password', () => {
    expect(resolveBastionAuthType('organization', [], 'password')).toBe('password')
  })

  it('keeps keyBased for jumpserver when current auth is keyBased', () => {
    expect(resolveBastionAuthType('organization', [], 'keyBased')).toBe('keyBased')
  })

  it('defaults to keyBased for jumpserver when current auth is invalid', () => {
    expect(resolveBastionAuthType('organization', [], 'token')).toBe('keyBased')
  })

  it('defaults to keyBased for jumpserver when current auth is missing', () => {
    expect(resolveBastionAuthType('organization', [])).toBe('keyBased')
  })

  it('falls back to definition authPolicy when current is not allowed', () => {
    const defs: BastionDefinitionSummary[] = [{ type: 'qizhi', authPolicy: ['keyBased'] }]
    expect(resolveBastionAuthType('organization-qizhi', defs, 'password')).toBe('keyBased')
  })

  it('keeps current auth type when allowed', () => {
    const defs: BastionDefinitionSummary[] = [{ type: 'tencent', authPolicy: ['password', 'keyBased'] }]
    expect(resolveBastionAuthType('organization-tencent', defs, 'password')).toBe('password')
  })

  it('preserves current auth type when definition is missing', () => {
    expect(resolveBastionAuthType('organization-unknown', [], 'keyBased')).toBe('keyBased')
  })

  it('ignores invalid current auth type when definition is missing', () => {
    expect(resolveBastionAuthType('organization-unknown', [], 'token')).toBe('password')
  })

  it('defaults to password for personal assets', () => {
    expect(resolveBastionAuthType('person', [], 'keyBased')).toBe('password')
  })
})
