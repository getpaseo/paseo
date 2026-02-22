import { afterEach, describe, expect, it, vi } from 'vitest'

type MockPlatform = 'web' | 'ios' | 'android'

type GlobalSnapshot = {
  Notification: unknown
  __TAURI__: unknown
  navigatorDescriptor?: PropertyDescriptor
}

const originalGlobals: GlobalSnapshot = {
  Notification: (globalThis as { Notification?: unknown }).Notification,
  __TAURI__: (globalThis as { __TAURI__?: unknown }).__TAURI__,
  navigatorDescriptor: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
}

function setNavigator(value: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value,
  })
}

function restoreGlobals(): void {
  ;(globalThis as { Notification?: unknown }).Notification = originalGlobals.Notification
  ;(globalThis as { __TAURI__?: unknown }).__TAURI__ = originalGlobals.__TAURI__

  if (originalGlobals.navigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalGlobals.navigatorDescriptor)
  } else {
    delete (globalThis as { navigator?: unknown }).navigator
  }
}

async function loadModuleForPlatform(platform: MockPlatform) {
  vi.resetModules()
  vi.doMock('react-native', () => ({ Platform: { OS: platform } }))
  return import('./desktop-permissions')
}

describe('desktop-permissions', () => {
  afterEach(() => {
    vi.doUnmock('react-native')
    vi.restoreAllMocks()
    vi.resetModules()
    restoreGlobals()
  })

  it('shows section only in Tauri web runtime', async () => {
    const { shouldShowDesktopPermissionSection } = await loadModuleForPlatform('web')

    expect(shouldShowDesktopPermissionSection()).toBe(false)

    ;(globalThis as { __TAURI__?: unknown }).__TAURI__ = { notification: {} }
    expect(shouldShowDesktopPermissionSection()).toBe(true)
  })

  it('reads notification and microphone status', async () => {
    const isPermissionGranted = vi.fn(async () => false)
    ;(globalThis as { __TAURI__?: unknown }).__TAURI__ = {
      notification: { isPermissionGranted },
    }
    setNavigator({
      permissions: {
        query: vi.fn(async () => ({ state: 'granted' })),
      },
      mediaDevices: {
        getUserMedia: vi.fn(),
      },
    })

    const { getDesktopPermissionSnapshot } = await loadModuleForPlatform('web')
    const snapshot = await getDesktopPermissionSnapshot()

    expect(snapshot.notifications.state).toBe('not-granted')
    expect(snapshot.microphone.state).toBe('granted')
    expect(isPermissionGranted).toHaveBeenCalledTimes(1)
    expect(snapshot.checkedAt).toBeTypeOf('number')
  })

  it('queries microphone permission with correct Permissions instance binding', async () => {
    const permissions = {
      query(this: unknown, _descriptor: { name: string }) {
        if (this !== permissions) {
          throw new TypeError(
            'Can only call Permissions.query on instances of Permissions'
          )
        }
        return Promise.resolve({ state: 'granted' as const })
      },
    }

    setNavigator({
      permissions,
      mediaDevices: {
        getUserMedia: vi.fn(),
      },
    })

    const { getDesktopPermissionSnapshot } = await loadModuleForPlatform('web')
    const snapshot = await getDesktopPermissionSnapshot()

    expect(snapshot.microphone.state).toBe('granted')
  })

  it('returns a fallback message when runtime blocks Permissions.query', async () => {
    setNavigator({
      permissions: {
        query: vi.fn(async () => {
          throw new TypeError(
            'Can only call Permissions.query on instances of Permissions'
          )
        }),
      },
      mediaDevices: {
        getUserMedia: vi.fn(),
      },
    })

    const { getDesktopPermissionSnapshot } = await loadModuleForPlatform('web')
    const snapshot = await getDesktopPermissionSnapshot()

    expect(snapshot.microphone.state).toBe('unknown')
    expect(snapshot.microphone.detail).toContain(
      'Microphone status API is unavailable in this runtime.'
    )
  })

  it('requests notification permission via Tauri', async () => {
    const requestPermission = vi.fn(async () => 'granted')
    ;(globalThis as { __TAURI__?: unknown }).__TAURI__ = {
      notification: { requestPermission },
    }

    const { requestDesktopPermission } = await loadModuleForPlatform('web')
    const result = await requestDesktopPermission({ kind: 'notifications' })

    expect(result.state).toBe('granted')
    expect(requestPermission).toHaveBeenCalledTimes(1)
  })

  it('falls back to browser Notification permission when Tauri API is unavailable', async () => {
    class MockNotification {
      static permission = 'denied'
    }
    ;(globalThis as { Notification?: unknown }).Notification = MockNotification
    setNavigator({})

    const { getDesktopPermissionSnapshot } = await loadModuleForPlatform('web')
    const snapshot = await getDesktopPermissionSnapshot()

    expect(snapshot.notifications.state).toBe('denied')
  })

  it('requests microphone permission and stops acquired tracks', async () => {
    const stop = vi.fn()
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop }],
    }))
    setNavigator({
      permissions: {
        query: vi.fn(async () => ({ state: 'granted' })),
      },
      mediaDevices: {
        getUserMedia,
      },
    })

    const { requestDesktopPermission } = await loadModuleForPlatform('web')
    const result = await requestDesktopPermission({ kind: 'microphone' })

    expect(result.state).toBe('granted')
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('maps microphone request denial to denied status', async () => {
    setNavigator({
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          throw { name: 'NotAllowedError', message: 'denied' }
        }),
      },
    })

    const { requestDesktopPermission } = await loadModuleForPlatform('web')
    const result = await requestDesktopPermission({ kind: 'microphone' })

    expect(result.state).toBe('denied')
  })
})
