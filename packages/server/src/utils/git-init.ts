import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat, mkdir } from 'node:fs/promises'
import path from 'node:path'

const execFileAsync = promisify(execFile)

const VALID_PROJECT_NAME = /^[a-zA-Z0-9._-]+$/

export interface InitRepositoryOptions {
  targetDirectory: string
  projectName: string
  homeDir: string
}

export async function initRepository(
  options: InitRepositoryOptions
): Promise<{ createdPath: string }> {
  if (!VALID_PROJECT_NAME.test(options.projectName)) {
    throw new Error(
      'Invalid project name. Use only letters, numbers, hyphens, underscores, and dots.'
    )
  }

  const resolvedParent = path.resolve(options.targetDirectory)
  const resolvedHome = path.resolve(options.homeDir)
  if (!resolvedParent.startsWith(resolvedHome + path.sep) && resolvedParent !== resolvedHome) {
    throw new Error('Target directory must be inside the home directory.')
  }

  const fullPath = path.join(resolvedParent, options.projectName)

  try {
    await stat(fullPath)
    throw new Error('Directory already exists.')
  } catch (e: unknown) {
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e
    }
    if (e instanceof Error && e.message === 'Directory already exists.') {
      throw e
    }
  }

  await mkdir(fullPath, { recursive: true })
  await execFileAsync('git', ['init'], {
    cwd: fullPath,
    timeout: 15_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  })

  return { createdPath: fullPath }
}
