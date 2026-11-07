// Only N and O have pinned labels here; formatShortcut turns Backspace, Enter,
// and arrows into glyphs on both platforms, so prefixing an arbitrary key fails.
export function hostModShortcutLabel(key: "N" | "O"): string {
  if (key === "N") return process.platform === "darwin" ? "⌘N" : "Ctrl+N";
  return process.platform === "darwin" ? "⌘O" : "Ctrl+O";
}
