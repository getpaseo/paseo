import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { CodePosition, CodeRange } from "@getpaseo/protocol/messages";
import type { DefinitionTarget, GoToDefinitionCallbacks } from "./go-to-definition";

/**
 * The word under the pointer underlines the moment the modifier is held, before the daemon has
 * answered. The language server's own range replaces it when the answer arrives, and the
 * underline disappears if nothing resolved. Waiting for the round trip first made a warm server
 * feel sluggish and a cold one feel broken.
 */
const RESOLVE_DEBOUNCE_MS = 40;

type Resolved = { originRange?: CodeRange; target: DefinitionTarget } | null;

interface Span {
  from: number;
  to: number;
}

const setHighlight = StateEffect.define<Span | null>();
const setPending = StateEffect.define<boolean>();

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

/** A cold server takes seconds to answer; the cursor says the click was received. */
const pendingField = StateField.define<boolean>({
  create: () => false,
  update(pending, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setPending)) {
        return effect.value;
      }
    }
    return pending;
  },
  provide: (field) =>
    EditorView.contentAttributes.from(field, (pending) => ({
      class: pending ? "cm-definitionPending" : "",
    })),
});

const linkTheme = EditorView.baseTheme({
  ".cm-definitionLink": {
    textDecoration: "underline",
    textUnderlineOffset: "2px",
    cursor: "pointer",
  },
  ".cm-definitionPending": { cursor: "progress" },
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

/** Prefer the server's own range; fall back to the word that was underlined optimistically. */
function highlightFor(view: EditorView, fallback: Span, resolved: Resolved): Span | null {
  if (!resolved) {
    return null;
  }
  const range = resolved.originRange;
  if (!range) {
    return fallback;
  }
  return { from: offsetAt(view, range.start), to: offsetAt(view, range.end) };
}

function wordAt(view: EditorView, offset: number): Span | null {
  const word = view.state.wordAt(offset);
  return word ? { from: word.from, to: word.to } : null;
}

export function goToDefinition(callbacks: GoToDefinitionCallbacks): Extension {
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let hoveredWord: Span | null = null;
  /** Keyed by word start. Holds misses too, so a word that resolves to nothing is asked once. */
  let cache = new Map<number, Resolved>();

  function clearHighlight(view: EditorView): void {
    clearTimeout(debounceTimer);
    hoveredWord = null;
    if (view.state.field(highlightField).size > 0) {
      view.dispatch({ effects: setHighlight.of(null) });
    }
  }

  function resolveWord(view: EditorView, word: Span): Promise<Resolved> {
    const cached = cache.get(word.from);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }
    return callbacks.resolve(positionAt(view, word.from)).then((resolved) => {
      cache.set(word.from, resolved);
      return resolved;
    });
  }

  function handleHover(view: EditorView, word: Span): void {
    hoveredWord = word;
    const cached = cache.get(word.from);
    // A known miss leaves the text alone instead of flashing an underline onto it.
    view.dispatch({
      effects: setHighlight.of(cached === undefined ? word : highlightFor(view, word, cached)),
    });
    if (cached !== undefined) {
      return;
    }

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void resolveWord(view, word).then((resolved) => {
        if (hoveredWord?.from === word.from) {
          view.dispatch({ effects: setHighlight.of(highlightFor(view, word, resolved)) });
        }
        return undefined;
      });
    }, RESOLVE_DEBOUNCE_MS);
  }

  return [
    highlightField,
    pendingField,
    linkTheme,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        cache = new Map();
      }
    }),
    EditorView.domEventHandlers({
      mousemove(event, view) {
        if (!hasModifier(event)) {
          clearHighlight(view);
          return;
        }
        const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const word = offset === null ? null : wordAt(view, offset);
        if (!word) {
          clearHighlight(view);
          return;
        }
        if (hoveredWord?.from === word.from && hoveredWord.to === word.to) {
          return;
        }
        handleHover(view, word);
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
        const word = offset === null ? null : wordAt(view, offset);
        if (!word) {
          return false;
        }
        event.preventDefault();
        view.dispatch({ effects: setPending.of(true) });
        void resolveWord(view, word).then((resolved) => {
          view.dispatch({ effects: [setPending.of(false), setHighlight.of(null)] });
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
