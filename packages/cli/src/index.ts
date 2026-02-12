import { createCli } from './cli.js'

const program = createCli()
if (process.argv.length <= 2) {
  process.argv.push('onboard')
}
program.parse()
