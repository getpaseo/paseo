import { createE2ETestContext } from '../helpers/test-daemon.ts'

const schema = JSON.stringify({
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
  additionalProperties: false,
})

async function main() {
  const ctx = await createE2ETestContext({ timeout: 180000 })
  try {
    const run = await ctx.paseo([
      'run',
      '--provider','opencode',
      '--mode','default',
      '--model','opencode/kimi-k2.5-free',
      '--output-schema', schema,
      'Return valid JSON with a short summary for provider opencode.'
    ], { timeout: 180000 })
    console.log('RUN EXIT', run.exitCode)
    console.log('RUN STDOUT\n' + run.stdout)
    console.log('RUN STDERR\n' + run.stderr)

    const ls = await ctx.paseo(['ls','--json'])
    console.log('LS\n' + ls.stdout)
    const agents = JSON.parse(ls.stdout)
    const agentId = agents[0]?.id
    if (agentId) {
      const inspect = await ctx.paseo(['inspect', agentId])
      console.log('INSPECT\n' + inspect.stdout)
      const logs = await ctx.paseo(['logs','--tail','100', agentId], { timeout: 30000 })
      console.log('LOGS\n' + logs.stdout)
    }
  } finally {
    await ctx.stop()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
