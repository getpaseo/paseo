export type ShortcutKey =
  | "mod"
  | "shift"
  | "alt"
  | "ctrl"
  | "meta"
  | string;

export type ShortcutOs = "mac" | "non-mac";

function normalizeKey(key: string): string {
  if (!key) return "";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

export function formatShortcut(keys: ShortcutKey[], os: ShortcutOs): string {
  const normalized = keys.map((k) => (typeof k === "string" ? k : String(k)));

  if (os === "mac") {
    const order = ["ctrl", "alt", "shift", "mod", "meta"];
    const symbols: Record<string, string> = {
      mod: "⌘",
      shift: "⇧",
      alt: "⌥",
      ctrl: "⌃",
      meta: "⌘",
    };

    const modifierSet = new Set(normalized);
    const mods = order
      .filter((k) => modifierSet.has(k))
      .map((k) => symbols[k] ?? "");
    const main = normalized
      .filter((k) => !order.includes(k))
      .map(normalizeKey)
      .join("");
    return `${mods.join("")}${main}`;
  }

  const labels: Record<string, string> = {
    mod: "Ctrl",
    shift: "Shift",
    alt: "Alt",
    ctrl: "Ctrl",
    meta: "Win",
  };
  return normalized
    .map((k) => labels[k] ?? normalizeKey(k))
    .filter(Boolean)
    .join("+");
}

