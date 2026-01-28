import { DaemonClientV2 } from '@paseo/server'
import WebSocket from 'ws'

export interface ConnectOptions {
  host?: string
  timeout?: number
}

const DEFAULT_HOST = 'localhost:6767'
const DEFAULT_TIMEOUT = 5000

/**
 * Get the daemon host from environment or options
 */
export function getDaemonHost(options?: ConnectOptions): string {
  return options?.host ?? process.env.PASEO_HOST ?? DEFAULT_HOST
}

/**
 * Create a WebSocket factory that works in Node.js
 */
function createNodeWebSocketFactory() {
  return (url: string, options?: { headers?: Record<string, string> }) => {
    return new WebSocket(url, { headers: options?.headers }) as unknown as {
      readyState: number
      send: (data: string) => void
      close: (code?: number, reason?: string) => void
      on: (event: string, listener: (...args: unknown[]) => void) => void
      off: (event: string, listener: (...args: unknown[]) => void) => void
    }
  }
}

/**
 * Create and connect a daemon client
 * Returns the connected client or throws if connection fails
 */
export async function connectToDaemon(options?: ConnectOptions): Promise<DaemonClientV2> {
  const host = getDaemonHost(options)
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT
  const url = `ws://${host}/ws`

  const client = new DaemonClientV2({
    url,
    webSocketFactory: createNodeWebSocketFactory(),
    reconnect: { enabled: false },
  })

  // Connect with timeout
  const connectPromise = client.connect()
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Connection timeout after ${timeout}ms`))
    }, timeout)
  })

  try {
    await Promise.race([connectPromise, timeoutPromise])
    return client
  } catch (err) {
    await client.close().catch(() => {})
    throw err
  }
}

/**
 * Try to connect to the daemon, returns null if connection fails
 */
export async function tryConnectToDaemon(options?: ConnectOptions): Promise<DaemonClientV2 | null> {
  try {
    return await connectToDaemon(options)
  } catch {
    return null
  }
}
