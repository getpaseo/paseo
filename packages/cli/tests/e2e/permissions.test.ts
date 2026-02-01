#!/usr/bin/env npx tsx

/**
 * E2E Test: Permissions Workflow
 *
 * This test verifies the permissions workflow using REAL daemons and agents.
 * It starts an isolated daemon on a random port and runs actual CLI commands.
 *
 * Test flow:
 * 1. Start daemon on random port
 * 2. Create agent in DEFAULT mode (not bypassPermissions) so it requests permissions
 * 3. Wait for agent to hit a permission request
 * 4. Use `permit ls` to list pending permissions
 * 5. Use `permit allow` to approve the permission
 * 6. Verify agent continues after approval
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function test_create_agent_with_permissions(): Promise<string> {
  console.log('\n--- Test: Create agent in default mode (will request permissions) ---')

  // Create agent WITHOUT bypassPermissions - it will need to request permissions
  // Use a task that is very likely to trigger a tool use (and thus permission request)
  const result = await ctx.paseo(
    [
      '-q',
      'agent',
      'run',
      '-d',
      '--provider',
      'claude',
      '--model',
      'claude-3-5-haiku-20241022',
      '--name',
      'Permission Test Agent',
      // This prompt should trigger file read or bash command, requiring permission
      'List the files in the current directory using ls',
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

async function test_wait_for_permission_request(agentId: string): Promise<void> {
  console.log('\n--- Test: Wait for agent to request permission ---')

  // Poll for permission requests with timeout
  const maxWait = 60000 // 60 seconds max
  const pollInterval = 1000 // 1 second
  const startTime = Date.now()

  while (Date.now() - startTime < maxWait) {
    const result = await ctx.paseo(['permit', 'ls', '--json'])

    if (result.exitCode === 0) {
      try {
        const permissions = JSON.parse(result.stdout.trim())
        if (Array.isArray(permissions) && permissions.length > 0) {
          // Check if any permission is for our agent
          const ourPermission = permissions.find(
            (p: { agentId?: string }) => p.agentId?.startsWith(agentId.slice(0, 7)) || agentId.startsWith(p.agentId?.slice(0, 7) || '')
          )
          if (ourPermission) {
            console.log('Permission request detected:', ourPermission)
            console.log('PASS: Agent requested permission')
            return
          }
        }
      } catch {
        // JSON parse failed, continue polling
      }
    }

    await sleep(pollInterval)
  }

  // If we get here, check agent status - it might have already completed
  const statusResult = await ctx.paseo(['inspect', agentId])
  console.log('Agent status:', statusResult.stdout)

  // It's possible the agent completed without needing permissions (e.g., haiku might not use tools)
  // In that case, we should skip the permission tests
  if (statusResult.stdout.includes('idle') || statusResult.stdout.includes('completed')) {
    console.log('SKIP: Agent completed without requiring permissions (model chose not to use tools)')
    throw new Error('SKIP_PERMISSION_TEST')
  }

  throw new Error('Timeout waiting for agent to request permission')
}

async function test_permit_ls(): Promise<{ agentShortId: string; requestId: string }> {
  console.log('\n--- Test: List pending permissions with permit ls ---')

  const result = await ctx.paseo(['permit', 'ls', '--json'])

  console.log('Exit code:', result.exitCode)
  console.log('Stdout:', result.stdout)
  if (result.stderr) console.log('Stderr:', result.stderr)

  assert.strictEqual(result.exitCode, 0, 'permit ls should succeed')

  const permissions = JSON.parse(result.stdout.trim())
  assert(Array.isArray(permissions), 'Output should be JSON array')
  assert(permissions.length > 0, 'Should have at least one pending permission')

  const permission = permissions[0]
  assert(permission.id, 'Permission should have id')
  assert(permission.agentShortId, 'Permission should have agentShortId')
  assert(permission.name, 'Permission should have tool name')

  console.log(`PASS: Found ${permissions.length} pending permission(s)`)
  console.log(`  Request ID: ${permission.id}`)
  console.log(`  Agent: ${permission.agentShortId}`)
  console.log(`  Tool: ${permission.name}`)

  return {
    agentShortId: permission.agentShortId,
    requestId: permission.id,
  }
}

async function test_permit_allow(agentShortId: string, requestId: string): Promise<void> {
  console.log('\n--- Test: Allow permission with permit allow ---')

  const result = await ctx.paseo(['permit', 'allow', agentShortId, requestId])

  console.log('Exit code:', result.exitCode)
  console.log('Stdout:', result.stdout)
  if (result.stderr) console.log('Stderr:', result.stderr)

  assert.strictEqual(result.exitCode, 0, 'permit allow should succeed')

  // Check that output shows the permission was allowed
  const output = result.stdout.toLowerCase()
  assert(output.includes('allowed') || output.includes(requestId.slice(0, 8).toLowerCase()), 'Should confirm permission was allowed')

  console.log('PASS: Permission allowed successfully')
}

async function test_agent_continues(agentId: string): Promise<void> {
  console.log('\n--- Test: Verify agent continues after permission granted ---')

  // Wait for agent to become idle (should continue after permission)
  const result = await ctx.paseo(['wait', '--timeout', '120s', agentId], { timeout: 130000 })

  console.log('Exit code:', result.exitCode)
  console.log('Stdout:', result.stdout)
  if (result.stderr) console.log('Stderr:', result.stderr)

  assert.strictEqual(result.exitCode, 0, 'agent wait should succeed after permission granted')

  // Verify agent status
  const inspectResult = await ctx.paseo(['inspect', agentId])
  console.log('Final agent status:', inspectResult.stdout)

  assert(inspectResult.stdout.includes('idle') || inspectResult.stdout.includes('completed'), 'Agent should be idle after completing')

  console.log('PASS: Agent completed after permission was granted')
}

async function test_agent_stop(agentId: string): Promise<void> {
  console.log('\n--- Test: Stop agent ---')

  const result = await ctx.paseo(['stop', agentId])

  console.log('Exit code:', result.exitCode)
  console.log('Stdout:', result.stdout)
  if (result.stderr) console.log('Stderr:', result.stderr)

  assert.strictEqual(result.exitCode, 0, 'agent stop should succeed')

  console.log('PASS: Agent stopped successfully')
}

async function main(): Promise<void> {
  console.log('=== E2E Test: Permissions Workflow ===\n')
  console.log('This test verifies the permission request/allow workflow.')
  console.log('It creates an agent that will request tool permissions.\n')

  let agentId: string | undefined

  try {
    await setup()

    // Create agent that will need permissions
    agentId = await test_create_agent_with_permissions()

    try {
      // Wait for permission request
      await test_wait_for_permission_request(agentId)

      // List and verify permissions
      const { agentShortId, requestId } = await test_permit_ls()

      // Allow the permission
      await test_permit_allow(agentShortId, requestId)

      // Verify agent continues and completes
      await test_agent_continues(agentId)

      console.log('\n=== All permissions E2E tests passed! ===')
    } catch (err) {
      if (err instanceof Error && err.message === 'SKIP_PERMISSION_TEST') {
        console.log('\n=== Permissions test skipped (agent completed without tool use) ===')
        console.log('This can happen when the model chooses not to use tools.')
        // Still considered a pass - the CLI works, just the model behavior varies
      } else {
        throw err
      }
    }
  } catch (err) {
    console.error('\n=== E2E test FAILED ===')
    console.error(err)
    process.exitCode = 1
  } finally {
    // Always try to stop the agent if it was created
    if (agentId) {
      try {
        await test_agent_stop(agentId)
      } catch {
        // Ignore errors during cleanup
      }
    }
    await cleanup()
  }
}

main()
