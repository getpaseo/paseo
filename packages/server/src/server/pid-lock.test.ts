import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { acquirePidLock, getPidLockInfo, releasePidLock } from './pid-lock.js'

describe('pid-lock ownership', () => {
  test('writes and releases lock for explicit owner pid', async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), 'paseo-pid-lock-owner-'))
    const ownerPid = process.pid + 10_000

    try {
      await (acquirePidLock as unknown as (home: string, sockPath: string, options: { ownerPid: number }) => Promise<void>)(
        paseoHome,
        '127.0.0.1:6767',
        { ownerPid }
      )

      const lock = await getPidLockInfo(paseoHome)
      expect(lock?.pid).toBe(ownerPid)

      await (releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>)(
        paseoHome,
        { ownerPid: ownerPid + 1 }
      )
      const lockAfterWrongOwnerRelease = await getPidLockInfo(paseoHome)
      expect(lockAfterWrongOwnerRelease?.pid).toBe(ownerPid)

      await (releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>)(
        paseoHome,
        { ownerPid }
      )
      const lockAfterOwnerRelease = await getPidLockInfo(paseoHome)
      expect(lockAfterOwnerRelease).toBeNull()
    } finally {
      await rm(paseoHome, { recursive: true, force: true })
    }
  })
})
