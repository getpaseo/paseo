import { Platform } from 'react-native'
import { getTauri, type TauriNotificationPermission } from '@/utils/tauri'

export type DesktopPermissionKind = 'notifications' | 'microphone'

export type DesktopPermissionState =
  | 'granted'
  | 'denied'
  | 'prompt'
  | 'not-granted'
  | 'unavailable'
  | 'unknown'

export interface DesktopPermissionStatus {
  state: DesktopPermissionState
  detail: string
}

export interface DesktopPermissionSnapshot {
  checkedAt: number
  notifications: DesktopPermissionStatus
  microphone: DesktopPermissionStatus
}

type NotificationConstructorLike = {
  permission?: string
  requestPermission?: () => Promise<string>
}

type MediaStreamTrackLike = {
  stop?: () => void
}

type MediaStreamLike = {
  getTracks?: () => MediaStreamTrackLike[]
}

type NavigatorLike = {
  mediaDevices?: {
    getUserMedia?: (constraints: { audio: boolean }) => Promise<MediaStreamLike>
  }
  permissions?: {
    query?: (descriptor: { name: string }) => Promise<{ state?: string }>
  }
}

export function shouldShowDesktopPermissionSection(): boolean {
  return Platform.OS === 'web' && getTauri() !== null
}

function status(input: DesktopPermissionStatus): DesktopPermissionStatus {
  return input
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') {
    return error.message
  }
  return String(error)
}

function getErrorName(error: unknown): string | null {
  if (!isObject(error)) {
    return null
  }
  const name = error.name
  return typeof name === 'string' && name.length > 0 ? name : null
}

function isPermissionsQueryRuntimeUnsupported(error: unknown): boolean {
  const message = getErrorMessage(error)
  if (
    message.includes('Can only call Permissions.query on instances of Permissions') ||
    message.includes('Illegal invocation')
  ) {
    return true
  }
  return false
}

function getWebNotificationConstructor(): NotificationConstructorLike | null {
  if (Platform.OS !== 'web') {
    return null
  }
  const NotificationConstructor = (globalThis as { Notification?: unknown }).Notification
  if (
    NotificationConstructor == null ||
    (typeof NotificationConstructor !== 'function' && typeof NotificationConstructor !== 'object')
  ) {
    return null
  }
  return NotificationConstructor as NotificationConstructorLike
}

function getNavigatorLike(): NavigatorLike | null {
  if (Platform.OS !== 'web') {
    return null
  }
  const webNavigator = (globalThis as { navigator?: unknown }).navigator
  if (!isObject(webNavigator)) {
    return null
  }
  return webNavigator as NavigatorLike
}

function mapNotificationPermissionString(permission: string): DesktopPermissionStatus {
  if (permission === 'granted') {
    return status({
      state: 'granted',
      detail: 'Notifications are allowed by the OS.',
    })
  }
  if (permission === 'denied') {
    return status({
      state: 'denied',
      detail: 'Notifications are denied in system settings.',
    })
  }
  if (permission === 'default') {
    return status({
      state: 'prompt',
      detail: 'Notifications have not been granted yet.',
    })
  }
  return status({
    state: 'unknown',
    detail: `Unexpected notification permission state: ${permission}`,
  })
}

function mapTauriNotificationPermissionResult(
  permission: TauriNotificationPermission
): DesktopPermissionStatus {
  if (permission === 'granted') {
    return status({
      state: 'granted',
      detail: 'Notifications are allowed by the OS.',
    })
  }
  if (permission === 'denied') {
    return status({
      state: 'denied',
      detail: 'Notifications are denied in system settings.',
    })
  }
  return status({
    state: 'prompt',
    detail: 'Notifications have not been granted yet.',
  })
}

async function getNotificationPermissionStatus(): Promise<DesktopPermissionStatus> {
  if (Platform.OS !== 'web') {
    return status({
      state: 'unavailable',
      detail: 'Desktop notification status is only available on web runtime.',
    })
  }

  const tauriNotification = getTauri()?.notification
  if (tauriNotification) {
    if (typeof tauriNotification.isPermissionGranted !== 'function') {
      return status({
        state: 'unavailable',
        detail: 'Tauri notification plugin is missing isPermissionGranted().',
      })
    }

    try {
      const granted = await tauriNotification.isPermissionGranted()
      if (granted) {
        return status({
          state: 'granted',
          detail: 'Tauri reports notifications are granted.',
        })
      }
      return status({
        state: 'not-granted',
        detail: 'Tauri reports notifications are not granted. Use Request to prompt.',
      })
    } catch (error) {
      return status({
        state: 'unknown',
        detail: `Failed to read notification status: ${getErrorMessage(error)}`,
      })
    }
  }

  const NotificationConstructor = getWebNotificationConstructor()
  if (!NotificationConstructor || typeof NotificationConstructor.permission !== 'string') {
    return status({
      state: 'unavailable',
      detail: 'Web Notification API is unavailable in this environment.',
    })
  }

  return mapNotificationPermissionString(NotificationConstructor.permission)
}

async function getMicrophonePermissionStatus(): Promise<DesktopPermissionStatus> {
  if (Platform.OS !== 'web') {
    return status({
      state: 'unavailable',
      detail: 'Desktop microphone status is only available on web runtime.',
    })
  }

  const webNavigator = getNavigatorLike()
  if (!webNavigator) {
    return status({
      state: 'unavailable',
      detail: 'Navigator is unavailable in this environment.',
    })
  }

  const permissionsApi = webNavigator.permissions
  if (permissionsApi && typeof permissionsApi.query === 'function') {
    try {
      const result = await permissionsApi.query({ name: 'microphone' })
      if (result?.state === 'granted') {
        return status({
          state: 'granted',
          detail: 'Microphone access is granted.',
        })
      }
      if (result?.state === 'denied') {
        return status({
          state: 'denied',
          detail: 'Microphone access is denied in system settings.',
        })
      }
      if (result?.state === 'prompt') {
        return status({
          state: 'prompt',
          detail: 'Microphone permission has not been granted yet.',
        })
      }
      return status({
        state: 'unknown',
        detail: `Unexpected microphone permission state: ${result?.state ?? 'unknown'}`,
      })
    } catch (error) {
      if (isPermissionsQueryRuntimeUnsupported(error)) {
        return status({
          state: 'unknown',
          detail:
            'Microphone status API is unavailable in this runtime. Use Request to check access.',
        })
      }
      return status({
        state: 'unknown',
        detail: `Failed to query microphone status: ${getErrorMessage(error)}`,
      })
    }
  }

  if (typeof webNavigator.mediaDevices?.getUserMedia !== 'function') {
    return status({
      state: 'unavailable',
      detail: 'Microphone capture is unavailable in this environment.',
    })
  }

  return status({
    state: 'unknown',
    detail: 'Permission status API is unavailable. Use Request to check access.',
  })
}

async function requestNotificationPermissionStatus(): Promise<DesktopPermissionStatus> {
  if (Platform.OS !== 'web') {
    return status({
      state: 'unavailable',
      detail: 'Desktop notification requests are only available on web runtime.',
    })
  }

  const tauriNotification = getTauri()?.notification
  if (tauriNotification) {
    if (typeof tauriNotification.requestPermission !== 'function') {
      return status({
        state: 'unavailable',
        detail: 'Tauri notification plugin is missing requestPermission().',
      })
    }

    try {
      const permission = await tauriNotification.requestPermission()
      return mapTauriNotificationPermissionResult(permission)
    } catch (error) {
      return status({
        state: 'unknown',
        detail: `Failed to request notification permission: ${getErrorMessage(error)}`,
      })
    }
  }

  const NotificationConstructor = getWebNotificationConstructor()
  if (!NotificationConstructor || typeof NotificationConstructor.requestPermission !== 'function') {
    return status({
      state: 'unavailable',
      detail: 'Web Notification API requestPermission() is unavailable.',
    })
  }

  try {
    const permission = await NotificationConstructor.requestPermission()
    return mapNotificationPermissionString(permission)
  } catch (error) {
    return status({
      state: 'unknown',
      detail: `Failed to request notification permission: ${getErrorMessage(error)}`,
    })
  }
}

async function requestMicrophonePermissionStatus(): Promise<DesktopPermissionStatus> {
  if (Platform.OS !== 'web') {
    return status({
      state: 'unavailable',
      detail: 'Desktop microphone requests are only available on web runtime.',
    })
  }

  const webNavigator = getNavigatorLike()
  if (!webNavigator || typeof webNavigator.mediaDevices?.getUserMedia !== 'function') {
    return status({
      state: 'unavailable',
      detail: 'Microphone capture API is unavailable in this environment.',
    })
  }

  try {
    const stream = await webNavigator.mediaDevices.getUserMedia({ audio: true })
    const tracks = stream && typeof stream.getTracks === 'function' ? stream.getTracks() : []
    tracks.forEach((track) => {
      if (typeof track.stop === 'function') {
        track.stop()
      }
    })
    return await getMicrophonePermissionStatus()
  } catch (error) {
    const errorName = getErrorName(error)
    if (errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError') {
      return status({
        state: 'denied',
        detail: 'Microphone permission was denied by the user or system.',
      })
    }
    if (errorName === 'NotFoundError' || errorName === 'DevicesNotFoundError') {
      return status({
        state: 'unavailable',
        detail: 'No microphone device was found.',
      })
    }
    return status({
      state: 'unknown',
      detail: `Failed to request microphone permission: ${getErrorMessage(error)}`,
    })
  }
}

export async function requestDesktopPermission(input: {
  kind: DesktopPermissionKind
}): Promise<DesktopPermissionStatus> {
  if (input.kind === 'notifications') {
    return await requestNotificationPermissionStatus()
  }
  return await requestMicrophonePermissionStatus()
}

export async function getDesktopPermissionSnapshot(): Promise<DesktopPermissionSnapshot> {
  const [notifications, microphone] = await Promise.all([
    getNotificationPermissionStatus(),
    getMicrophonePermissionStatus(),
  ])

  return {
    checkedAt: Date.now(),
    notifications,
    microphone,
  }
}
