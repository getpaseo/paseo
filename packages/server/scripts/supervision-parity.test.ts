import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

describe('supervision parity', () => {
  test('has exactly one runtime callsite for runSupervisor', () => {
    const daemonRunner = readFileSync(new URL('./daemon-runner.ts', import.meta.url), 'utf8')
    const devRunner = readFileSync(new URL('./dev-runner.ts', import.meta.url), 'utf8')

    const daemonRunnerCalls = (daemonRunner.match(/\brunSupervisor\s*\(/g) ?? []).length
    const devRunnerCalls = (devRunner.match(/\brunSupervisor\s*\(/g) ?? []).length

    expect(daemonRunnerCalls + devRunnerCalls).toBe(1)
  })
})
