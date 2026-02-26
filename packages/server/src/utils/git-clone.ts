import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat, mkdir } from 'node:fs/promises'
import path from 'node:path'

const execFileAsync = promisify(execFile)

const ALLOWED_URL_PATTERNS = [
  /^https:\/\//,
  /^git:\/\//,
  /^git@[^:]+:/,
  /^ssh:\/\//,
]

export function isValidGitCloneUrl(url: string): boolean {
  return ALLOWED_URL_PATTERNS.some((pattern) => pattern.test(url))
}

export interface CloneRepositoryOptions {
  url: string
  targetDirectory: string
  homeDir: string
}

export async function cloneRepository(
  options: CloneRepositoryOptions
): Promise<{ clonedPath: string }> {
  if (!isValidGitCloneUrl(options.url)) {
    throw new Error(
      'Invalid git clone URL. Only https://, git://, and ssh:// URLs are allowed.'
    )
  }

  const resolvedTarget = path.resolve(options.targetDirectory)
  const resolvedHome = path.resolve(options.homeDir)
  if (!resolvedTarget.startsWith(resolvedHome + path.sep) && resolvedTarget !== resolvedHome) {
    throw new Error('Target directory must be inside the home directory.')
  }

  const parentDir = path.dirname(resolvedTarget)
  await mkdir(parentDir, { recursive: true })

  try {
    await stat(resolvedTarget)
    throw new Error('Target directory already exists.')
  } catch (e: unknown) {
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e
    }
    if (e instanceof Error && e.message === 'Target directory already exists.') {
      throw e
    }
  }

  await execFileAsync('git', ['clone', options.url, resolvedTarget], {
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  })

  return { clonedPath: resolvedTarget }
}
