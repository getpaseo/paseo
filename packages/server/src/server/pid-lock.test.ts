import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { acquirePidLock, getPidLockInfo, releasePidLock } from './pid-lock.js'

describe('pid-lock ownership', () => {
  test('writes and releases lock for explicit owner pid', async () => {
    const junctionHome = await mkdtemp(join(tmpdir(), 'junction-pid-lock-owner-'))
    const ownerPid = process.pid + 10_000

    try {
      await (acquirePidLock as unknown as (home: string, sockPath: string, options: { ownerPid: number }) => Promise<void>)(
        junctionHome,
        '127.0.0.1:6767',
        { ownerPid }
      )

      const lock = await getPidLockInfo(junctionHome)
      expect(lock?.pid).toBe(ownerPid)

      await (releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>)(
        junctionHome,
        { ownerPid: ownerPid + 1 }
      )
      const lockAfterWrongOwnerRelease = await getPidLockInfo(junctionHome)
      expect(lockAfterWrongOwnerRelease?.pid).toBe(ownerPid)

      await (releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>)(
        junctionHome,
        { ownerPid }
      )
      const lockAfterOwnerRelease = await getPidLockInfo(junctionHome)
      expect(lockAfterOwnerRelease).toBeNull()
    } finally {
      await rm(junctionHome, { recursive: true, force: true })
    }
  })
})
