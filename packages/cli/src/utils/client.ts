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
    client.subscribeAgentUpdates({ subscriptionId: `cli:${process.pid}` })
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

/** Minimal agent type for ID resolution */
interface AgentLike {
  id: string
  title?: string | null
}

/**
 * Resolve an agent ID from a partial ID or name.
 * Supports:
 * - Full ID match
 * - Prefix match (first N characters)
 * - Title/name match (case-insensitive)
 *
 * Returns the full agent ID if found, null otherwise.
 */
export function resolveAgentId(idOrName: string, agents: AgentLike[]): string | null {
  if (!idOrName || agents.length === 0) {
    return null
  }

  const query = idOrName.toLowerCase()

  // Try exact ID match first
  const exactMatch = agents.find((a) => a.id === idOrName)
  if (exactMatch) {
    return exactMatch.id
  }

  // Try ID prefix match
  const prefixMatches = agents.filter((a) => a.id.toLowerCase().startsWith(query))
  if (prefixMatches.length === 1 && prefixMatches[0]) {
    return prefixMatches[0].id
  }

  // Try title/name match (case-insensitive)
  const titleMatches = agents.filter((a) => a.title?.toLowerCase() === query)
  if (titleMatches.length === 1 && titleMatches[0]) {
    return titleMatches[0].id
  }

  // Try partial title match
  const partialTitleMatches = agents.filter((a) => a.title?.toLowerCase().includes(query))
  if (partialTitleMatches.length === 1 && partialTitleMatches[0]) {
    return partialTitleMatches[0].id
  }

  // If we have multiple prefix matches and no unique title match, return first prefix match
  const firstPrefixMatch = prefixMatches[0]
  if (firstPrefixMatch) {
    return firstPrefixMatch.id
  }

  return null
}
