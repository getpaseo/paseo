import { useCallback, useRef, useState } from 'react'
import {
  checkDesktopAppUpdate,
  installDesktopAppUpdate,
  shouldShowDesktopUpdateSection,
  type DesktopAppUpdateCheckResult,
  type DesktopAppUpdateInstallResult,
} from '@/desktop/updates/desktop-updates'

export type DesktopAppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'installing'
  | 'installed'
  | 'error'

export interface UseDesktopAppUpdaterReturn {
  isDesktop: boolean
  status: DesktopAppUpdateStatus
  statusText: string
  availableUpdate: DesktopAppUpdateCheckResult | null
  errorMessage: string | null
  lastCheckedAt: number | null
  isChecking: boolean
  isInstalling: boolean
  checkForUpdates: (options?: { silent?: boolean }) => Promise<DesktopAppUpdateCheckResult | null>
  installUpdate: () => Promise<DesktopAppUpdateInstallResult | null>
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') {
    return error.message
  }
  return String(error)
}

function formatStatusText(input: {
  status: DesktopAppUpdateStatus
  availableUpdate: DesktopAppUpdateCheckResult | null
  installMessage: string | null
}): string {
  const { status, availableUpdate, installMessage } = input

  if (status === 'checking') {
    return 'Checking for app updates...'
  }

  if (status === 'installing') {
    return 'Installing app update...'
  }

  if (status === 'up-to-date') {
    return 'App is up to date.'
  }

  if (status === 'available') {
    if (availableUpdate?.latestVersion) {
      return `Update available: ${availableUpdate.latestVersion}`
    }
    return 'An app update is available.'
  }

  if (status === 'installed') {
    return installMessage ?? 'App update installed. Restart required.'
  }

  if (status === 'error') {
    return 'Failed to update app.'
  }

  return 'Update status has not been checked yet.'
}

export function useDesktopAppUpdater(): UseDesktopAppUpdaterReturn {
  const isDesktop = shouldShowDesktopUpdateSection()
  const requestVersionRef = useRef(0)
  const [status, setStatus] = useState<DesktopAppUpdateStatus>('idle')
  const [availableUpdate, setAvailableUpdate] = useState<DesktopAppUpdateCheckResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [installMessage, setInstallMessage] = useState<string | null>(null)
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null)

  const checkForUpdates = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!isDesktop) {
        return null
      }

      const requestVersion = requestVersionRef.current + 1
      requestVersionRef.current = requestVersion

      if (!options.silent) {
        setStatus('checking')
      }
      setErrorMessage(null)

      try {
        const result = await checkDesktopAppUpdate()
        if (requestVersion !== requestVersionRef.current) {
          return result
        }

        setInstallMessage(null)
        setLastCheckedAt(Date.now())

        if (result.hasUpdate) {
          setAvailableUpdate(result)
          setStatus('available')
        } else {
          setAvailableUpdate(null)
          setStatus('up-to-date')
        }

        return result
      } catch (error) {
        if (requestVersion !== requestVersionRef.current) {
          return null
        }

        const message = getErrorMessage(error)
        if (options.silent) {
          console.warn('[DesktopUpdater] Silent update check failed', message)
        } else {
          setStatus('error')
          setErrorMessage(message)
        }
        return null
      }
    },
    [isDesktop]
  )

  const installUpdate = useCallback(async () => {
    if (!isDesktop) {
      return null
    }

    setStatus('installing')
    setErrorMessage(null)

    try {
      const result = await installDesktopAppUpdate()
      setLastCheckedAt(Date.now())

      if (result.installed) {
        setAvailableUpdate(null)
        setInstallMessage(result.message)
        setStatus('installed')
      } else {
        setAvailableUpdate(null)
        setInstallMessage(result.message)
        setStatus('up-to-date')
      }

      return result
    } catch (error) {
      const message = getErrorMessage(error)
      setStatus('error')
      setErrorMessage(message)
      return null
    }
  }, [isDesktop])

  return {
    isDesktop,
    status,
    statusText: formatStatusText({
      status,
      availableUpdate,
      installMessage,
    }),
    availableUpdate,
    errorMessage,
    lastCheckedAt,
    isChecking: status === 'checking',
    isInstalling: status === 'installing',
    checkForUpdates,
    installUpdate,
  }
}
