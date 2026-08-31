import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { CodePosition, CodeRange } from "@getpaseo/protocol/messages";
import type { GoToDefinitionCallbacks } from "./go-to-definition";

/**
 * Hovering with the modifier held resolves the symbol under the pointer and underlines the
 * range the language server reported. That hover also warms the server's project graph, so
 * the click that follows lands on an already-loaded session instead of a cold start.
 */
const HOVER_RESOLVE_DELAY_MS = 120;

const setHighlight = StateEffect.define<{ from: number; to: number } | null>();

const symbolMark = Decoration.mark({ class: "cm-definitionLink" });

const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(highlight, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setHighlight)) {
        return effect.value
          ? Decoration.set([symbolMark.range(effect.value.from, effect.value.to)])
          : Decoration.none;
      }
    }
    return transaction.docChanged ? Decoration.none : highlight.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

const linkTheme = EditorView.baseTheme({
  ".cm-definitionLink": {
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    cursor: "pointer",
  },
});

/** Cmd on macOS, Ctrl elsewhere — the same chord editors already trained people to use. */
function hasModifier(event: MouseEvent | KeyboardEvent): boolean {
  const isApple = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return isApple ? event.metaKey : event.ctrlKey;
}

function positionAt(view: EditorView, offset: number): CodePosition {
  const line = view.state.doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

function offsetAt(view: EditorView, position: CodePosition): number {
  const lineNumber = Math.min(position.line + 1, view.state.doc.lines);
  const line = view.state.doc.line(lineNumber);
  return Math.min(line.from + position.character, line.to);
}

/** Underline the server's own range when it gave one; otherwise mark nothing. */
function highlightFor(
  view: EditorView,
  offset: number,
  resolved: { originRange?: CodeRange } | null,
): { from: number; to: number } | null {
  if (!resolved) {
    return null;
  }
  const range = resolved.originRange;
  if (!range) {
    return { from: offset, to: offset + 1 };
  }
  return { from: offsetAt(view, range.start), to: offsetAt(view, range.end) };
}

export function goToDefinition(callbacks: GoToDefinitionCallbacks): Extension {
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let hoveredOffset: number | null = null;

  function clearHighlight(view: EditorView): void {
    clearTimeout(hoverTimer);
    hoveredOffset = null;
    if (view.state.field(highlightField).size > 0) {
      view.dispatch({ effects: setHighlight.of(null) });
    }
  }

  function scheduleResolve(view: EditorView, offset: number): void {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      const position = positionAt(view, offset);
      void callbacks.resolve(position).then((resolved) => {
        // The pointer moved on, or the modifier was released, while the request was in flight.
        if (hoveredOffset !== offset) {
          return undefined;
        }
        view.dispatch({ effects: setHighlight.of(highlightFor(view, offset, resolved)) });
        return undefined;
      });
    }, HOVER_RESOLVE_DELAY_MS);
  }

  return [
    highlightField,
    linkTheme,
    EditorView.domEventHandlers({
      mousemove(event, view) {
        if (!hasModifier(event)) {
          clearHighlight(view);
          return;
        }
        const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (offset === null || offset === hoveredOffset) {
          return;
        }
        hoveredOffset = offset;
        scheduleResolve(view, offset);
      },
      mouseleave(_event, view) {
        clearHighlight(view);
      },
      keyup(_event, view) {
        clearHighlight(view);
      },
      mousedown(event, view) {
        if (!hasModifier(event) || event.button !== 0) {
          return false;
        }
        const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (offset === null) {
          return false;
        }
        event.preventDefault();
        clearHighlight(view);
        void callbacks.resolve(positionAt(view, offset)).then((resolved) => {
          if (resolved) {
            callbacks.navigate(resolved.target);
          }
          return undefined;
        });
        return true;
      },
    }),
  ];
}
