import { atom } from "jotai"
import { atomWithStorage } from "jotai/utils"

/** Whether the sidebar is open */
export const sidebarOpenAtom = atomWithStorage("junction:sidebar-open", true)

/** Sidebar width in pixels */
export const sidebarWidthAtom = atomWithStorage("junction:sidebar-width", 240)

/** Selected agent — includes daemonId so we know which client to use */
export interface SelectedAgent {
  agentId: string
  daemonId: string
}
export const selectedAgentAtom = atom<SelectedAgent | null>(null)

// Convenience alias for backward compat during migration
export const selectedAgentIdAtom = atom(
  (get) => get(selectedAgentAtom)?.agentId ?? null,
  (_get, set, value: string | null) => {
    // Setting just an agentId without daemonId is used during reconnect/legacy flows
    // It will be paired with the active connection
    if (value === null) {
      set(selectedAgentAtom, null)
    }
    // For string-only sets, we can't set without daemonId — clear instead
  },
)

/** Whether to show the new chat form */
export const showNewChatFormAtom = atom(false)

/** Pending new chat config — set by NewChatForm, consumed by AgentsContent */
export interface NewChatConfig {
  provider: "claude" | "codex" | "opencode"
  cwd: string
  initialPrompt: string
  daemonId: string
}
export const pendingNewChatAtom = atom<NewChatConfig | null>(null)

/** Collapsed daemon sections in sidebar (by daemon profile ID) */
export const collapsedDaemonsAtom = atomWithStorage<string[]>(
  "junction:collapsed-daemons",
  [],
)

/** Daemon filter — which daemon IDs to show (empty = show all) */
export const daemonFilterAtom = atom<string[]>([])
