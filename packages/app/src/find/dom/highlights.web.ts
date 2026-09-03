export interface FindHighlightColors {
  match: string;
  active: string;
}

export interface FindHighlightContribution {
  matches: readonly Range[];
  active: Range | null;
}

export interface FindHighlightRegistry {
  /** Replaces this contributor's ranges. */
  publish: (token: string, contribution: FindHighlightContribution) => void;
  release: (token: string) => void;
  setColors: (colors: FindHighlightColors) => void;
}

const MATCH_HIGHLIGHT = "paseo-find-match";
const ACTIVE_HIGHLIGHT = "paseo-find-match-active";
const STYLE_ELEMENT_ID = "paseo-find-highlight-style";

/**
 * Firefox shipped the CSS Custom Highlight API in 140. On anything older find still
 * counts, navigates and scrolls; only the marks are missing.
 */
const HIGHLIGHTS_SUPPORTED = typeof CSS !== "undefined" && "highlights" in CSS;

/**
 * The one place DOM find marks are painted.
 *
 * `CSS.highlights` is a per-document registry keyed by name, so a second surface
 * writing `paseo-find-match` would replace the first surface's ranges rather than add
 * to them — and retained panels plus split panes keep several find surfaces alive at
 * once. Contributors publish under their own token and this merges them into the two
 * document-level Highlight objects.
 */
function createFindHighlightRegistry(): FindHighlightRegistry {
  const contributions = new Map<string, FindHighlightContribution>();
  let appliedColors = "";

  const apply = () => {
    if (!HIGHLIGHTS_SUPPORTED) {
      return;
    }
    const matchHighlight = new Highlight();
    const activeHighlight = new Highlight();
    for (const contribution of contributions.values()) {
      if (contribution.active) {
        activeHighlight.add(contribution.active);
      }
      // The active range is deliberately not also a plain match: two highlights over
      // the same text paint in an order the spec leaves to `priority`, and excluding
      // it makes the active mark win without depending on that.
      for (const range of contribution.matches) {
        if (range !== contribution.active) {
          matchHighlight.add(range);
        }
      }
    }
    CSS.highlights.set(MATCH_HIGHLIGHT, matchHighlight);
    CSS.highlights.set(ACTIVE_HIGHLIGHT, activeHighlight);
  };

  return {
    publish(token, contribution) {
      contributions.set(token, contribution);
      apply();
    },

    release(token) {
      contributions.delete(token);
      apply();
    },

    setColors(colors) {
      const next = `${colors.match}|${colors.active}`;
      if (next === appliedColors) {
        return;
      }
      appliedColors = next;
      styleElement().textContent = [
        `::highlight(${MATCH_HIGHLIGHT}) { background-color: ${colors.match}; }`,
        `::highlight(${ACTIVE_HIGHLIGHT}) { background-color: ${colors.active}; }`,
      ].join("\n");
    },
  };
}

function styleElement(): HTMLStyleElement {
  const existing = document.getElementById(STYLE_ELEMENT_ID);
  if (existing instanceof HTMLStyleElement) {
    return existing;
  }
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  document.head.append(style);
  return style;
}

const registry = createFindHighlightRegistry();

export function getFindHighlights(): FindHighlightRegistry {
  return registry;
}
