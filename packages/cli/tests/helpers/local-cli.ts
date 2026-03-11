import { $, ProcessPromise } from 'zx'
import { join } from 'node:path'

const CLI_ENTRY = join(import.meta.dirname, '..', '..', 'dist', 'index.js')

export function runLocalPaseo(args: string[], env: NodeJS.ProcessEnv = {}): ProcessPromise {
  $.verbose = false
  return $({ env: { ...process.env, ...env } })`${process.execPath} ${CLI_ENTRY} ${args}`.nothrow()
}
