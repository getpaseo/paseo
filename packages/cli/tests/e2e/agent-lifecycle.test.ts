#!/usr/bin/env npx tsx

/**
 * E2E Test: Agent Lifecycle
 *
 * This test verifies the complete agent lifecycle using REAL daemons and agents.
 * It starts an isolated daemon on a random port and runs actual CLI commands.
 *
 * Test flow:
 * 1. Start daemon on random port
 * 2. Create agent with `paseo run "say hello" --provider claude`
 * 3. List agents with `paseo ls`
 * 4. Wait for agent with `paseo wait <id>`
 * 5. Inspect agent with `paseo inspect <id>`
 * 6. Stop agent with `paseo stop <id>`
 * 7. Cleanup: stop daemon, remove temp dirs
 *
 * CRITICAL RULES:
 * - NEVER use port 6767 (user's running daemon)
 * - Always use claude provider with haiku model for fast, cheap tests
 * - Clean up resources after test completes
 */

import assert from 'node:assert'
import { createE2ETestContext, type TestDaemonContext } from '../helpers/test-daemon.ts'

interface E2EContext extends TestDaemonContext {
  paseo: (args: string[], opts?: { timeout?: number; cwd?: string }) => Promise<{
    exitCode: number
    stdout: string
    stderr: string
  }>
}

let ctx: E2EContext

async function setup(): Promise<void> {
  console.log('Setting up E2E test context...')
  console.log('Starting test daemon on random port (this may take a few seconds)...')

  try {
    ctx = await createE2ETestContext({ timeout: 45000 })
    console.log(`Test daemon started on port ${ctx.port}`)
    console.log(`PASEO_HOME: ${ctx.paseoHome}`)
    console.log(`Work directory: ${ctx.workDir}`)
  } catch (err) {
    console.error('Failed to start test daemon:', err)
    throw err
  }
}

async function cleanup(): Promise<void> {
  console.log('\nCleaning up...')
  if (ctx) {
    await ctx.stop()
    console.log('Test daemon stopped and temp directories removed')
  }
}

async function test_agent_ls_empty(): Promise<void> {
  console.log('\n--- Test: agent ls with empty list ---')

  const result = await ctx.paseo(['ls', '--format', 'json'])

  console.log('Exit code:', result.exitCode)
  console.log('Stdout:', result.stdout)
  if (result.stderr) console.log('Stderr:', result.stderr)

  assert.strictEqual(result.exitCode, 0, 'agent ls should succeed')

  const agents = JSON.parse(result.stdout.trim())
  assert(Array.isArray(agents), 'Output should be JSON array')
  assert.strictEqual(agents.length, 0, 'Should have no agents initially')

  console.log('PASS: agent ls returns empty list')
}

async function test_agent_run_detached(): Promise<string> {
  console.log('\n--- Test: agent run detached ---')

  // Use quiet mode to get just the agent ID
  // CRITICAL: Use haiku model for fast, cheap tests
  // CRITICAL: Use bypassPermissions mode so agent doesn't wait for permission approvals
  const result = await ctx.paseo(
    [
      '-q',
      'run',
      '-d',
      '--provider',
      'claude',
      '--model',
      'claude-3-5-haiku-20241022',
      '--mode',
      'bypassPermissions',
      '--name',
      'E2E Test Agent',
      'Say hello world',
    ],
    { timeout: 60000 }
  )

  console.log('Exit code:', result.exitCode)
  console.log('Stdout:', result.stdout)
  if (result.stderr) console.log('Stderr:', result.stderr)

  assert.strictEqual(result.exitCode, 0, 'agent run should succeed')

  const agentId = result.stdout.trim()
  assert(agentId.length > 0, 'Should return agent ID')
  assert(agentId.match(/^[a-z0-9-]+$/), `Agent ID should be alphanumeric: ${agentId}`)

  console.log(`PASS: agent created with ID: ${agentId}`)
  return agentId
}

async function test_agent_ls_shows_agent(agentId: string): Promise<void> {
  console.log('\n--- Test: agent ls shows created agent ---')

  const result = await ctx.paseo(['ls', '--format', 'json'])

  console.log('Exit code:', result.exitCode)
  console.log('Stdout:', result.stdout)

  assert.strictEqual(result.exitCode, 0, 'agent ls should succeed')

  const agents = JSON.parse(result.stdout.trim()) as Array<{ id: string; title?: string; status?: string }>
  assert(Array.isArray(agents), 'Output should be JSON array')
  assert(agents.length >= 1, 'Should have at least one agent')

  // Find our agent by ID prefix
  const ourAgent = agents.find((a) => agentId.startsWith(a.id) || a.id.startsWith(agentId.slice(0, 7)))
  assert(ourAgent, `Our agent ${agentId} should be in the list`)

  console.log('Agent found:', ourAgent)
  console.log('PASS: agent ls shows created agent')
}

async function test_agent_wait(agentId: string): Promise<void> {
  console.log('\n--- Test: agent wait ---')

  // Wait for agent to become idle (with generous timeout for haiku model)
  const result = await ctx.paseo(['wait', '--timeout', '120s', agentId], { timeout: 130000 })

  console.log('Exit code:', result.exitCode)
  console.log('Stdout:', result.stdout)
  if (result.stderr) console.log('Stderr:', result.stderr)

  assert.strictEqual(result.exitCode, 0, 'agent wait should succeed')

  console.log('PASS: agent wait completed successfully')
}

async function test_agent_inspect(agentId: string): Promise<void> {
  console.log('\n--- Test: agent inspect ---')

  const result = await ctx.paseo(['inspect', agentId])

  console.log('Exit code:', result.exitCode)
  console.log('Stdout:', result.stdout)

  assert.strictEqual(result.exitCode, 0, 'agent inspect should succeed')

  // Check that output contains expected fields (table format)
  const output = result.stdout
  assert(output.includes('Id'), 'Output should contain Id field')
  assert(output.includes('Provider'), 'Output should contain Provider field')
  assert(output.includes('Status'), 'Output should contain Status field')
  assert(output.includes('claude'), 'Output should mention claude provider')

  console.log('PASS: agent inspect shows expected fields')
}

async function test_agent_logs(agentId: string): Promise<void> {
  console.log('\n--- Test: agent logs ---')

  const result = await ctx.paseo(['logs', '--tail', '20', agentId])

  console.log('Exit code:', result.exitCode)
  console.log('Stdout length:', result.stdout.length)
  // Don't print full logs as they can be verbose

  assert.strictEqual(result.exitCode, 0, 'agent logs should succeed')
  // Logs should have some content (agent was asked to say hello)
  assert(result.stdout.length > 0, 'Logs should have some content')

  console.log('PASS: agent logs returns content')
}

async function test_agent_stop(agentId: string): Promise<void> {
  console.log('\n--- Test: agent stop ---')

  const result = await ctx.paseo(['stop', agentId])

  console.log('Exit code:', result.exitCode)
  console.log('Stdout:', result.stdout)
  if (result.stderr) console.log('Stderr:', result.stderr)

  assert.strictEqual(result.exitCode, 0, 'agent stop should succeed')

  // Verify agent is no longer in running list
  const psResult = await ctx.paseo(['ls', '--format', 'json'])
  const agents = JSON.parse(psResult.stdout.trim()) as Array<{ id: string; status?: string }>

  // Agent might still be in list but should not be running
  const ourAgent = agents.find((a) => agentId.startsWith(a.id) || a.id.startsWith(agentId.slice(0, 7)))
  if (ourAgent) {
    assert(ourAgent.status !== 'running', 'Agent should not be running after stop')
  }

  console.log('PASS: agent stop completed successfully')
}

async function main(): Promise<void> {
  console.log('=== E2E Test: Agent Lifecycle ===\n')
  console.log('This test creates REAL agents with REAL daemons.')
  console.log('It may take some time as it waits for agent responses.\n')

  try {
    await setup()

    // Run tests in sequence
    await test_agent_ls_empty()

    const agentId = await test_agent_run_detached()

    await test_agent_ls_shows_agent(agentId)

    await test_agent_wait(agentId)

    await test_agent_inspect(agentId)

    await test_agent_logs(agentId)

    await test_agent_stop(agentId)

    console.log('\n=== All E2E tests passed! ===')
  } catch (err) {
    console.error('\n=== E2E test FAILED ===')
    console.error(err)
    process.exitCode = 1
  } finally {
    await cleanup()
  }
}

main()
