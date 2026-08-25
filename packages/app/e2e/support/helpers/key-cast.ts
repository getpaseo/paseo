import type { Page } from "@playwright/test";

/**
 * On-screen key cast for recorded runs.
 *
 * A recording of a keyboard feature is unreadable without showing the keys, so this paints the
 * key that was pressed and a caption for the step being demonstrated. It only installs when
 * E2E_RECORD_VIDEO is on, so ordinary runs drive the same page the user does.
 */

const KEY_CAST_STYLE = `
  #paseo-key-cast {
    position: fixed;
    inset: 64px 0 auto 0;
    z-index: 2147483647;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    pointer-events: none;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  #paseo-key-cast-caption {
    max-width: 70%;
    padding: 8px 18px;
    border-radius: 999px;
    background: rgba(12, 12, 14, 0.86);
    color: #f4f4f5;
    font-size: 17px;
    line-height: 1.3;
    text-align: center;
    opacity: 0;
    transition: opacity 160ms ease;
  }
  #paseo-key-cast-caption[data-visible="1"] { opacity: 1; }
  #paseo-key-cast-keys {
    display: flex;
    gap: 8px;
    align-items: center;
    min-height: 44px;
  }
  .paseo-key-cast-key {
    padding: 7px 14px;
    border-radius: 9px;
    background: rgba(24, 24, 27, 0.94);
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-bottom-width: 3px;
    color: #fafafa;
    font-size: 19px;
    font-weight: 600;
    letter-spacing: 0.3px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
    animation: paseo-key-cast-in 120ms ease-out;
  }
  .paseo-key-cast-key[data-fading="1"] { opacity: 0; transition: opacity 220ms ease; }
  @keyframes paseo-key-cast-in {
    from { transform: translateY(6px) scale(0.96); opacity: 0.2; }
    to { transform: none; opacity: 1; }
  }
`;

function keyCastScript(): void {
  const LABELS: Record<string, string> = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Enter: "⏎ Enter",
    Escape: "Esc",
    Backspace: "⌫",
    Tab: "⇥ Tab",
    " ": "Space",
  };
  const MODIFIER_KEYS = new Set(["Shift", "Meta", "Control", "Alt"]);

  const install = () => {
    if (document.getElementById("paseo-key-cast")) return;
    if (!document.body) return;
    const root = document.createElement("div");
    root.id = "paseo-key-cast";
    const caption = document.createElement("div");
    caption.id = "paseo-key-cast-caption";
    const keys = document.createElement("div");
    keys.id = "paseo-key-cast-keys";
    root.append(caption, keys);
    document.body.append(root);

    let typedKey: HTMLElement | null = null;
    let typedText = "";

    const show = (label: string) => {
      const key = document.createElement("div");
      key.className = "paseo-key-cast-key";
      key.textContent = label;
      keys.append(key);
      while (keys.childElementCount > 6) keys.firstElementChild?.remove();
      window.setTimeout(() => {
        key.dataset.fading = "1";
        window.setTimeout(() => key.remove(), 260);
      }, 1_400);
      return key;
    };

    window.addEventListener(
      "keydown",
      (event) => {
        if (MODIFIER_KEYS.has(event.key)) return;
        const label = LABELS[event.key] ?? event.key;
        const isPrintable = label.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
        if (isPrintable) {
          // Collapse a burst of typing into one growing chip, the way a screencast reads.
          if (typedKey?.isConnected && !typedKey.dataset.fading) {
            typedText += label;
            typedKey.textContent = typedText;
            return;
          }
          typedText = label;
          typedKey = show(label);
          return;
        }
        typedKey = null;
        const modifiers = [
          event.metaKey ? "⌘" : "",
          event.ctrlKey ? "⌃" : "",
          event.altKey ? "⌥" : "",
          event.shiftKey ? "⇧" : "",
        ].filter(Boolean);
        show([...modifiers, label].join(" "));
      },
      true,
    );

    const win = window as unknown as { __paseoKeyCastCaption?: (text: string) => void };
    win.__paseoKeyCastCaption = (text: string) => {
      caption.textContent = text;
      caption.dataset.visible = text ? "1" : "0";
    };
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
}

export function isRecordingVideo(): boolean {
  return process.env.E2E_RECORD_VIDEO === "1";
}

export async function installKeyCast(page: Page): Promise<void> {
  if (!isRecordingVideo()) return;
  await page.addInitScript({ content: `(${keyCastScript.toString()})();` });
  await page.addInitScript({
    content: `(() => {
    const style = document.createElement("style");
    style.textContent = ${JSON.stringify(KEY_CAST_STYLE)};
    const attach = () => document.head?.append(style);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", attach, { once: true });
    } else {
      attach();
    }
  })();`,
  });
}

/** Narrates the step in the recording, and paces it so it can be followed. */
export async function keyCastStep(page: Page, caption: string): Promise<void> {
  if (!isRecordingVideo()) return;
  await page.evaluate((text) => {
    const win = window as unknown as { __paseoKeyCastCaption?: (value: string) => void };
    win.__paseoKeyCastCaption?.(text);
  }, caption);
  await page.waitForTimeout(1_200);
}

/** A beat between key presses, so the recording is watchable. Free when not recording. */
export async function keyCastBeat(page: Page, ms = 700): Promise<void> {
  if (!isRecordingVideo()) return;
  await page.waitForTimeout(ms);
}
