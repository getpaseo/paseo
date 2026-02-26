import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { acquirePidLock, getPidLockInfo, listPidLocks, PidLockError, releasePidLock } from './pid-lock.js'

describe('pid-lock ownership', () => {
  test('writes and releases lock for explicit owner pid', async () => {
    const junctionHome = await mkdtemp(join(tmpdir(), 'junction-pid-lock-owner-'))
    const ownerPid = process.pid + 10_000

    try {
      await acquirePidLock(junctionHome, '127.0.0.1:6767', { ownerPid })

      const lock = await getPidLockInfo(junctionHome)
      expect(lock?.pid).toBe(ownerPid)

      // Wrong owner should not release
      await releasePidLock(junctionHome, { ownerPid: ownerPid + 1 })
      const lockAfterWrongOwnerRelease = await getPidLockInfo(junctionHome)
      expect(lockAfterWrongOwnerRelease?.pid).toBe(ownerPid)

      // Correct owner should release
      await releasePidLock(junctionHome, { ownerPid })
      const lockAfterOwnerRelease = await getPidLockInfo(junctionHome)
      expect(lockAfterOwnerRelease).toBeNull()
    } finally {
      await rm(junctionHome, { recursive: true, force: true })
    }
  })

  test('releases lock by sockPath', async () => {
    const junctionHome = await mkdtemp(join(tmpdir(), 'junction-pid-lock-sockpath-'))
    const ownerPid = process.pid + 10_000

    try {
      await acquirePidLock(junctionHome, '127.0.0.1:6767', { ownerPid })
      const lock = await getPidLockInfo(junctionHome, '127.0.0.1:6767')
      expect(lock?.pid).toBe(ownerPid)

      await releasePidLock(junctionHome, '127.0.0.1:6767', { ownerPid })
      const lockAfter = await getPidLockInfo(junctionHome, '127.0.0.1:6767')
      expect(lockAfter).toBeNull()
    } finally {
      await rm(junctionHome, { recursive: true, force: true })
    }
  })
})

describe('multi-daemon pid locks', () => {
  test('allows two locks with different sockPaths on same home', async () => {
    const junctionHome = await mkdtemp(join(tmpdir(), 'junction-pid-lock-multi-'))

    try {
      // Use current process PID for both — they differ by sockPath
      await acquirePidLock(junctionHome, '127.0.0.1:6767', { ownerPid: process.pid })
      await acquirePidLock(junctionHome, '127.0.0.1:6768', { ownerPid: process.pid })

      const lock1 = await getPidLockInfo(junctionHome, '127.0.0.1:6767')
      const lock2 = await getPidLockInfo(junctionHome, '127.0.0.1:6768')

      expect(lock1?.sockPath).toBe('127.0.0.1:6767')
      expect(lock2?.sockPath).toBe('127.0.0.1:6768')
    } finally {
      await rm(junctionHome, { recursive: true, force: true })
    }
  })

  test('rejects duplicate lock for same sockPath', async () => {
    const junctionHome = await mkdtemp(join(tmpdir(), 'junction-pid-lock-dup-'))

    try {
      await acquirePidLock(junctionHome, '127.0.0.1:6767', { ownerPid: process.pid })

      // Different owner PID trying same address should fail
      const otherPid = process.pid + 10_000
      // Since otherPid isn't actually running, acquirePidLock will treat the existing lock
      // as belonging to our running process and throw PidLockError
      await expect(
        acquirePidLock(junctionHome, '127.0.0.1:6767', { ownerPid: otherPid })
      ).rejects.toThrow(PidLockError)
    } finally {
      await rm(junctionHome, { recursive: true, force: true })
    }
  })

  test('listPidLocks returns all active locks', async () => {
    const junctionHome = await mkdtemp(join(tmpdir(), 'junction-pid-lock-list-'))

    try {
      await acquirePidLock(junctionHome, '127.0.0.1:6767', { ownerPid: process.pid })
      await acquirePidLock(junctionHome, '127.0.0.1:6768', { ownerPid: process.pid })

      const locks = await listPidLocks(junctionHome)
      expect(locks.length).toBe(2)

      const sockPaths = locks.map(l => l.sockPath).sort()
      expect(sockPaths).toEqual(['127.0.0.1:6767', '127.0.0.1:6768'])
    } finally {
      await rm(junctionHome, { recursive: true, force: true })
    }
  })

  test('listPidLocks filters out stale locks', async () => {
    const junctionHome = await mkdtemp(join(tmpdir(), 'junction-pid-lock-stale-'))
    const deadPid = 99999999

    try {
      // Create a lock with a non-existent PID
      await acquirePidLock(junctionHome, '127.0.0.1:6767', { ownerPid: deadPid })
      // Create a lock with our actual PID
      await acquirePidLock(junctionHome, '127.0.0.1:6768', { ownerPid: process.pid })

      const locks = await listPidLocks(junctionHome)
      // Only the live lock should be returned
      expect(locks.length).toBe(1)
      expect(locks[0]?.sockPath).toBe('127.0.0.1:6768')
    } finally {
      await rm(junctionHome, { recursive: true, force: true })
    }
  })
})
