import { atom } from "jotai"
import { atomWithStorage } from "jotai/utils"

/** Whether the sidebar is open */
export const sidebarOpenAtom = atomWithStorage("junction:sidebar-open", true)

/** Sidebar width in pixels */
export const sidebarWidthAtom = atomWithStorage("junction:sidebar-width", 240)

/** Currently selected agent ID */
export const selectedAgentIdAtom = atom<string | null>(null)

/** Whether to show the new chat form */
export const showNewChatFormAtom = atom(false)

/** Pending new chat config — set by NewChatForm, consumed by AgentsContent */
export interface NewChatConfig {
  provider: "claude" | "codex" | "opencode"
  cwd: string
  initialPrompt: string
}
export const pendingNewChatAtom = atom<NewChatConfig | null>(null)
