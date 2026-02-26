import { create } from "zustand"
import { persist } from "zustand/middleware"
import { nanoid } from "nanoid"
import { DaemonClient } from "@server/client/daemon-client"
import type { DaemonEvent } from "@server/client/daemon-client"

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"

export interface DaemonProfile {
  id: string
  label: string
  url: string
}

export interface DaemonConnection {
  status: ConnectionStatus
  client: DaemonClient
  unsubscribe?: () => void
}

interface DaemonState {
  // Persisted
  profiles: DaemonProfile[]
  activeConnectionId: string | null

  // Runtime (not persisted)
  connections: Map<string, DaemonConnection>

  // Actions
  addConnection: (url: string, label?: string) => Promise<string>
  reconnect: (profileId: string) => Promise<void>
  reconnectAll: () => Promise<void>
  removeConnection: (id: string) => void
  setActiveConnection: (id: string) => void
  getActiveClient: () => DaemonClient | null
  getClient: (id: string) => DaemonClient | null
}

function connectProfile(
  id: string,
  url: string,
  get: () => DaemonState,
  set: (partial: Partial<DaemonState> | ((state: DaemonState) => Partial<DaemonState>)) => void,
): { client: DaemonClient; connectPromise: Promise<void> } {
  const clientId = `junction-web-${nanoid(8)}`
  const client = new DaemonClient({ url, clientId, clientType: "browser" })

  // Set initial connecting state
  const connections = new Map(get().connections)
  connections.set(id, { status: "connecting", client })
  set({ connections })

  // Subscribe to connection status changes
  const unsubscribeStatus = client.subscribeConnectionStatus((connState) => {
    const newStatus: ConnectionStatus =
      connState.status === "connected"
        ? "connected"
        : connState.status === "connecting"
          ? "connecting"
          : "disconnected"

    const current = get().connections.get(id)
    if (current && current.status !== newStatus) {
      const conns = new Map(get().connections)
      conns.set(id, { ...current, status: newStatus })
      set({ connections: conns })
    }
  })

  // Store the unsubscribe function
  {
    const conns = new Map(get().connections)
    const conn = conns.get(id)
    if (conn) {
      conns.set(id, { ...conn, unsubscribe: unsubscribeStatus })
      set({ connections: conns })
    }
  }

  const connectPromise = client.connect().catch((e) => {
    const conns = new Map(get().connections)
    conns.set(id, { status: "error", client, unsubscribe: unsubscribeStatus })
    set({ connections: conns })
    throw e
  })

  return { client, connectPromise }
}

export const useDaemonStore = create<DaemonState>()(
  persist(
    (set, get) => ({
      profiles: [],
      activeConnectionId: null,
      connections: new Map(),

      addConnection: async (url: string, label?: string) => {
        const id = nanoid()
        const profile: DaemonProfile = {
          id,
          label:
            label ??
            new URL(
              url.replace("ws://", "http://").replace("wss://", "https://"),
            ).hostname,
          url,
        }

        // Add profile first
        set((state) => ({
          profiles: [...state.profiles, profile],
          activeConnectionId: state.activeConnectionId ?? id,
        }))

        const { connectPromise } = connectProfile(id, url, get, set)
        await connectPromise
        return id
      },

      reconnect: async (profileId: string) => {
        const profile = get().profiles.find((p) => p.id === profileId)
        if (!profile) return

        // Already connected or connecting — skip
        const existing = get().connections.get(profileId)
        if (existing && (existing.status === "connected" || existing.status === "connecting")) {
          return
        }

        // Clean up stale connection if any
        if (existing) {
          existing.unsubscribe?.()
          existing.client.close().catch(() => {})
        }

        const { connectPromise } = connectProfile(profileId, profile.url, get, set)
        await connectPromise
      },

      reconnectAll: async () => {
        const { profiles } = get()
        await Promise.allSettled(
          profiles.map((p) => get().reconnect(p.id)),
        )
      },

      removeConnection: (id: string) => {
        const conn = get().connections.get(id)
        if (conn) {
          conn.unsubscribe?.()
          conn.client.close().catch(() => {})
        }
        const connections = new Map(get().connections)
        connections.delete(id)
        set((state) => ({
          profiles: state.profiles.filter((p) => p.id !== id),
          activeConnectionId:
            state.activeConnectionId === id
              ? null
              : state.activeConnectionId,
          connections,
        }))
      },

      setActiveConnection: (id: string) => {
        set({ activeConnectionId: id })
      },

      getActiveClient: () => {
        const { activeConnectionId, connections } = get()
        if (!activeConnectionId) return null
        return connections.get(activeConnectionId)?.client ?? null
      },

      getClient: (id: string) => {
        return get().connections.get(id)?.client ?? null
      },
    }),
    {
      name: "junction-daemon-registry",
      partialize: (state) => ({
        profiles: state.profiles,
        activeConnectionId: state.activeConnectionId,
      }),
    },
  ),
)
