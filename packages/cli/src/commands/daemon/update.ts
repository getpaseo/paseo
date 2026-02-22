import { confirm, isCancel } from '@clack/prompts'
import { spawn } from 'node:child_process'
import { Command } from 'commander'
import chalk from 'chalk'
import { runRestartCommand } from './restart.js'
import { resolveLocalDaemonState } from './local-daemon.js'
import {
  resolveNpmInvocationFromNode,
  resolvePreferredNodePath,
  type NpmInvocation,
} from './runtime-toolchain.js'
import { getErrorMessage } from '../../utils/errors.js'

export interface DaemonUpdateOptions {
  home?: string
  yes?: boolean
}

function runCommand(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: process.env,
    })

    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Command exited via signal ${signal}`))
        return
      }
      resolve(code ?? 1)
    })
  })
}

export async function runDaemonUpdateCommand(options: DaemonUpdateOptions): Promise<void> {
  const daemonState = resolveLocalDaemonState({ home: options.home })
  const resolvedNode = resolvePreferredNodePath({
    daemonPid: daemonState.running ? daemonState.pidInfo?.pid : null,
    fallbackNodePath: process.execPath,
  })
  const npm: NpmInvocation = resolveNpmInvocationFromNode(resolvedNode.nodePath)
  const args = [...npm.argsPrefix, 'install', '-g', '@getpaseo/cli@latest']

  const exitCode = await runCommand(npm.command, args)
  if (exitCode !== 0) {
    throw new Error(`Update command failed with exit code ${exitCode}`)
  }

  let shouldRestart = options.yes === true
  if (!shouldRestart) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(chalk.yellow('Update complete. Restart skipped (non-interactive terminal).'))
      console.log(chalk.dim('Run `paseo daemon restart` when ready.'))
      return
    }

    console.log(
      chalk.yellow(
        'Restart will stop running agents, but they can continue from persisted state after restart.'
      )
    )
    const answer = await confirm({
      message: 'Restart daemon now?',
      active: 'Restart now',
      inactive: 'Later',
      initialValue: true,
    })

    if (isCancel(answer)) {
      console.log(chalk.yellow('Update complete. Restart skipped.'))
      return
    }

    shouldRestart = answer
  }

  if (!shouldRestart) {
    console.log(chalk.yellow('Update complete. Restart skipped.'))
    return
  }

  const restartResult = await runRestartCommand({ home: options.home }, new Command())
  console.log(chalk.green(restartResult.data.message))
}

export async function runDaemonUpdateCommandOrExit(options: DaemonUpdateOptions): Promise<void> {
  try {
    await runDaemonUpdateCommand(options)
  } catch (err) {
    console.error(chalk.red(`Failed to update daemon: ${getErrorMessage(err)}`))
    process.exit(1)
  }
}

export function updateCommand(): Command {
  return new Command('update')
    .description('Update local daemon package')
    .option('--home <path>', 'Paseo home directory (default: ~/.paseo)')
    .option('-y, --yes', 'Restart automatically after update')
    .action(async (options: DaemonUpdateOptions) => {
      await runDaemonUpdateCommandOrExit(options)
    })
}
