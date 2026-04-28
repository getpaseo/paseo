/**
 * Injects global CSS that themes all native browser scrollbars to match the
 * current unistyles theme. This covers any scrollable element that doesn't use
 * the custom `WebDesktopScrollbarOverlay`.
 *
 * Web-only — returns null on native.
 */

import { useEffect } from "react";
import { useUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";

const STYLE_ID = "hubcode-global-scrollbar";

function hexToRgba(hex: string, alpha: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function WebGlobalScrollbarStyle(): null {
  const { theme } = useUnistyles();

  useEffect(() => {
    if (!isWeb || typeof document === "undefined") return;

    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }

    const track = theme.colors.surface0;
    const thumb = theme.colors.scrollbarHandle;
    const thumbHover = hexToRgba(thumb, 0.85);
    const border = theme.colors.surface1;

    style.textContent = `
      /* Webkit (Chrome, Safari, Edge, Electron) */
      ::-webkit-scrollbar {
        width: 8px;
        height: 8px;
      }
      ::-webkit-scrollbar-track {
        background: ${track};
      }
      ::-webkit-scrollbar-thumb {
        background: ${hexToRgba(thumb, 0.45)};
        border-radius: 4px;
        border: 1px solid ${border};
      }
      ::-webkit-scrollbar-thumb:hover {
        background: ${thumbHover};
      }
      ::-webkit-scrollbar-corner {
        background: ${track};
      }

      /* Firefox */
      * {
        scrollbar-width: thin;
        scrollbar-color: ${hexToRgba(thumb, 0.45)} ${track};
      }

      /* Elements that explicitly hide scrollbar should still be hidden */
      [data-hide-scrollbar]::-webkit-scrollbar {
        display: none !important;
        width: 0 !important;
        height: 0 !important;
      }
    `;

    return () => {
      // Don't remove — next effect run updates in place.
      // Only remove on full unmount (app teardown).
    };
  }, [theme.colors.scrollbarHandle, theme.colors.surface0, theme.colors.surface1]);

  return null;
}
