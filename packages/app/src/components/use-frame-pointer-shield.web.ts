import { useEffect } from "react";

const STYLE_ID = "paseo-frame-pointer-shield";
const ACTIVE_ATTRIBUTE = "data-paseo-frame-pointer-shield";

// Pointer events over an iframe are delivered to the frame's own document, not to
// ours. dnd-kit's PointerSensor listens on this document and does not capture the
// pointer, so a tab drag that crosses an HTML preview or a Mermaid diagram stops
// receiving moves there and never sees the release: the drop preview freezes and
// the drag stays alive until the pointer leaves the frame. While a drag is active,
// frames stop being hit targets so every move lands on the app.
function installStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `[${ACTIVE_ATTRIBUTE}] iframe { pointer-events: none !important; }`;
  document.head.append(style);
}

export function useFramePointerShield(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    installStyle();
    const root = document.documentElement;
    root.setAttribute(ACTIVE_ATTRIBUTE, "");
    return () => root.removeAttribute(ACTIVE_ATTRIBUTE);
  }, [active]);
}
