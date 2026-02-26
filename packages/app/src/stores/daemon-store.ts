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
  removeConnection: (id: string) => void
  setActiveConnection: (id: string) => void
  getActiveClient: () => DaemonClient | null
  getClient: (id: string) => DaemonClient | null
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

        const clientId = `junction-web-${nanoid(8)}`
        const client = new DaemonClient({
          url,
          clientId,
          clientType: "browser",
        })

        // Add profile and set up initial connection state
        const connections = new Map(get().connections)
        connections.set(id, { status: "connecting", client })
        set((state) => ({
          profiles: [...state.profiles, profile],
          activeConnectionId: state.activeConnectionId ?? id,
          connections,
        }))

        // Subscribe to connection status changes
        const unsubscribeStatus = client.subscribeConnectionStatus(
          (connState) => {
            const newStatus: ConnectionStatus =
              connState.status === "connected"
                ? "connected"
                : connState.status === "connecting"
                  ? "connecting"
                  : connState.status === "disconnected"
                    ? "disconnected"
                    : "disconnected"

            const current = get().connections.get(id)
            if (current && current.status !== newStatus) {
              const connections = new Map(get().connections)
              connections.set(id, { ...current, status: newStatus })
              set({ connections })
            }
          },
        )

        // Store the unsubscribe function
        const conn = get().connections.get(id)
        if (conn) {
          const connections = new Map(get().connections)
          connections.set(id, { ...conn, unsubscribe: unsubscribeStatus })
          set({ connections })
        }

        // Connect and wait for welcome
        try {
          await client.connect()
          return id
        } catch (e) {
          const connections = new Map(get().connections)
          connections.set(id, {
            status: "error",
            client,
            unsubscribe: unsubscribeStatus,
          })
          set({ connections })
          throw e
        }
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

