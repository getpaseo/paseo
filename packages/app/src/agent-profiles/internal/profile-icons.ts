/**
 * A fixed emoji palette rather than free text or a native emoji keyboard: the
 * value is stored verbatim in the daemon config and rendered by every client,
 * so the set has to be small, stable and available on all four platforms.
 */
export interface AgentProfileIconChoice {
  /** Stable key for testIDs; the stored value is the emoji itself. */
  key: string;
  emoji: string;
}

export const AGENT_PROFILE_ICON_CHOICES: readonly AgentProfileIconChoice[] = [
  { key: "palette", emoji: "🎨" },
  { key: "flask", emoji: "🧪" },
  { key: "magnifier", emoji: "🔎" },
  { key: "bolt", emoji: "⚡️" },
  { key: "wrench", emoji: "🛠️" },
  { key: "memo", emoji: "📝" },
  { key: "bug", emoji: "🐛" },
  { key: "rocket", emoji: "🚀" },
  { key: "compass", emoji: "🧭" },
  { key: "package", emoji: "📦" },
  { key: "lock", emoji: "🔐" },
  { key: "robot", emoji: "🤖" },
];
