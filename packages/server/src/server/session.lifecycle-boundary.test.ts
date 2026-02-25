import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

describe('session lifecycle boundary', () => {
  test('does not perform process lifecycle side effects directly', () => {
    const source = readFileSync(new URL('./session.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/process\.(exit|send|kill)\s*\(/)
  })
})
