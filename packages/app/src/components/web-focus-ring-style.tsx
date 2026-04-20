import { useEffect } from "react";
import { isWeb } from "@/constants/platform";

const STYLE_ID = "hubcode-focus-ring";

/**
 * Global keyboard-focus ring for interactive elements on web. RN-Web's
 * Pressable strips the native outline, leaving keyboard users with no visual
 * focus indicator. We re-add it via `:focus-visible` (keyboard only — does not
 * fire on click/tap) using the brand magenta token so it matches the product's
 * accent color across themes.
 *
 * `:focus-visible` is the right primitive here: it shows the ring only when
 * the user is navigating via keyboard, never on mouse click. No JS state to
 * manage, no re-renders on focus change.
 */
export function WebFocusRingStyle() {
  useEffect(() => {
    if (!isWeb) return;
    if (document.getElementById(STYLE_ID)) return;

    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = `
      [role="button"]:focus-visible,
      button:focus-visible,
      a:focus-visible,
      input:focus-visible,
      textarea:focus-visible,
      [tabindex]:focus-visible {
        outline: 2px solid #C4198B !important;
        outline-offset: 2px !important;
        border-radius: 4px;
      }
      [data-hubcode-no-focus-ring]:focus-visible {
        outline: none !important;
      }
      /* Global smooth transitions for buttons/links. */
      [role="button"],
      button,
      a {
        transition: background-color 140ms ease-out, color 140ms ease-out,
                    border-color 140ms ease-out, transform 140ms ease-out,
                    box-shadow 140ms ease-out;
      }
      /* Row hover — CSS :hover applies while cursor is over the row OR any
         of its children (unlike RN Pressable's onHoverIn/Out which flip off
         as the pointer crosses into a nested Pressable). Keeps shared-workspace
         rows visually selected while the user reaches for Copy/Delete icons. */
      [data-hubcode-row="1"]:hover {
        background-color: rgba(255, 255, 255, 0.04);
      }
      /* Selected row glow — targeted via data attribute so it only lights up
         the single active channel/DM/session row at any given time. */
      [data-hubcode-selected="1"] {
        box-shadow: 0 0 0 1px rgba(196, 25, 139, 0.25),
                    0 8px 24px -12px rgba(196, 25, 139, 0.45) !important;
      }
      /* Soft pulse for online status indicators. */
      @keyframes hubcode-pulse {
        0%   { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.5); }
        70%  { box-shadow: 0 0 0 6px rgba(34, 197, 94, 0); }
        100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
      }
      [data-hubcode-online="1"] {
        animation: hubcode-pulse 2200ms ease-out infinite;
      }
      /* Shimmer for skeleton placeholders. */
      @keyframes hubcode-shimmer {
        0%   { background-position: -200% 0; }
        100% { background-position: 200% 0; }
      }
      [data-hubcode-skeleton="1"] {
        background: linear-gradient(
          90deg,
          rgba(255,255,255,0.03) 0%,
          rgba(255,255,255,0.08) 50%,
          rgba(255,255,255,0.03) 100%
        );
        background-size: 200% 100%;
        animation: hubcode-shimmer 1400ms ease-in-out infinite;
      }
      /* Press feedback — subtle scale-down for any tappable surface. */
      [role="button"]:active,
      button:active {
        transform: scale(0.98);
      }
      @media (prefers-reduced-motion: reduce) {
        [role="button"], button, a { transition: none !important; transform: none !important; }
        [data-hubcode-online="1"], [data-hubcode-skeleton="1"] { animation: none !important; }
      }
    `;
    document.head.appendChild(el);
  }, []);
  return null;
}
