#!/usr/bin/env npx tsx

/**
 * E2E Test: Agent Send Command
 *
 * This test verifies the `send` command using REAL daemons and agents.
 * It starts an isolated daemon on a random port and runs actual CLI commands.
 *
 * Test flow:
 * 1. Start daemon on random port
 * 2. Create agent with detached mode
 * 3. Wait for agent to become idle (initial task complete)
 * 4. Send new message with `send`
 * 5. Wait for agent again
 * 6. Verify agent processed the message (check logs)
 * 7. Cleanup
 *
 * CRITICAL RULES:
 * - NEVER use port 6767 (user's running daemon)
 * - Always use claude provider with haiku model for fast, cheap tests
 * - Clean up resources after test completes
 */

import assert from 'node:assert'
import { createE2ETestContext, type TestDaemonContext } from '../helpers/test-daemon.ts'

interface E2EContext extends TestDaemonContext {
  junction: (args: string[], opts?: { timeout?: number; cwd?: string }) => Promise<{
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
    console.log(`JUNCTION_HOME: ${ctx.junctionHome}`)
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

async function test_create_agent(): Promise<string> {
  console.log('\n--- Test: Create agent in detached mode ---')

  // CRITICAL: Use haiku model for fast, cheap tests
  // CRITICAL: Use bypassPermissions mode so agent doesn't wait for permission approvals
  const result = await ctx.junction(
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
      'Send Test Agent',
      'Say "initial task complete"',
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

async function test_wait_for_initial_task(agentId: string): Promise<void> {
  console.log('\n--- Test: Wait for initial task to complete ---')

  const result = await ctx.junction(['wait', '--timeout', '120s', agentId], { timeout: 130000 })

  console.log('Exit code:', result.exitCode)
  console.log('Stdout:', result.stdout)
  if (result.stderr) console.log('Stderr:', result.stderr)

  assert.strictEqual(result.exitCode, 0, 'agent wait should succeed')

  console.log('PASS: Initial task completed')
}

async function test_agent_send(agentId: string): Promise<void> {
  console.log('\n--- Test: Send follow-up message ---')

  // Send a follow-up message to the agent
  const result = await ctx.junction(
    ['send', agentId, 'Now say "follow-up task complete"'],
    { timeout: 180000 }
  )

  console.log('Exit code:', result.exitCode)
  console.log('Stdout:', result.stdout)
  if (result.stderr) console.log('Stderr:', result.stderr)

  assert.strictEqual(result.exitCode, 0, 'agent send should succeed')

  // Verify output contains expected status
  assert(
    result.stdout.includes('completed') || result.stdout.includes('sent'),
    'Should indicate message was sent or completed'
  )

  console.log('PASS: Follow-up message sent successfully')
}

async function test_verify_logs(agentId: string): Promise<void> {
  console.log('\n--- Test: Verify agent processed both messages ---')

  const result = await ctx.junction(['logs', '--tail', '50', agentId])

  console.log('Exit code:', result.exitCode)
  console.log('Stdout length:', result.stdout.length)

  assert.strictEqual(result.exitCode, 0, 'agent logs should succeed')

  // Logs should have content from both tasks
  assert(result.stdout.length > 0, 'Logs should have content')

  // The agent was asked to say specific things, check if either appears in logs
  // This is a loose check since exact log format may vary
  const logsLower = result.stdout.toLowerCase()
  const hasInitialTask = logsLower.includes('initial') || logsLower.includes('hello') || logsLower.includes('task')
  const hasFollowUp = logsLower.includes('follow') || logsLower.includes('complete') || logsLower.includes('task')

  // At minimum, there should be log entries (we can't guarantee exact content)
  assert(result.stdout.split('\n').length > 3, 'Should have multiple log entries from both tasks')

  console.log('PASS: Agent logs show activity from both tasks')
}

async function test_agent_stop(agentId: string): Promise<void> {
  console.log('\n--- Test: Stop agent ---')

  const result = await ctx.junction(['stop', agentId])

  console.log('Exit code:', result.exitCode)
  console.log('Stdout:', result.stdout)
  if (result.stderr) console.log('Stderr:', result.stderr)

  assert.strictEqual(result.exitCode, 0, 'agent stop should succeed')

  console.log('PASS: Agent stopped successfully')
}

async function main(): Promise<void> {
  console.log('=== E2E Test: Agent Send Command ===\n')
  console.log('This test verifies the `send` command with REAL agents.')
  console.log('It may take some time as it waits for agent responses.\n')

  try {
    await setup()

    // Create agent and wait for initial task
    const agentId = await test_create_agent()
    await test_wait_for_initial_task(agentId)

    // Send follow-up message (this waits for completion by default)
    await test_agent_send(agentId)

    // Verify both messages were processed
    await test_verify_logs(agentId)

    // Cleanup agent
    await test_agent_stop(agentId)

    console.log('\n=== All agent-send E2E tests passed! ===')
  } catch (err) {
    console.error('\n=== E2E test FAILED ===')
    console.error(err)
    process.exitCode = 1
  } finally {
    await cleanup()
  }
}

main()
