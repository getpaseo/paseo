import { SearchQuery, getSearchQuery, setSearchQuery } from "@codemirror/search";
import {
  EditorSelection,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Transaction,
} from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { FindEngine, FindResult } from "@/find/engine";
import { stepActiveIndex } from "@/find/model";

/**
 * Counting walks the whole document, so a one-letter query in a large file would
 * otherwise collect millions of matches on every keystroke. A count this high already
 * means "more than anyone will step through"; matches past it are neither counted nor
 * reachable.
 */
const MATCH_COUNT_LIMIT = 10_000;

interface Match {
  from: number;
  to: number;
}

interface FindMatchState {
  /** Every counted match, in document order and never overlapping. */
  matches: readonly Match[];
  activeIndex: number | null;
}

const EMPTY_MATCH_STATE: FindMatchState = { matches: [], activeIndex: null };

const MATCH_MARK = Decoration.mark({ class: "cm-paseoFindMatch" });
const ACTIVE_MATCH_MARK = Decoration.mark({ class: "cm-paseoFindMatchActive" });

const setActiveMatch = StateEffect.define<number | null>();

/**
 * The match list is editor state, not something each reader recomputes.
 *
 * CodeMirror offers two ways to walk matches and they disagree: `SearchQuery.getCursor`
 * skips a hit that overlaps the previous one, while the `findNext` command re-anchors a
 * fresh cursor at the selection and happily lands on a hit the cursor skipped. Searching
 * `==` in `a === b` therefore used to leave the caret on a match the counter had never
 * counted — no active mark, and a position in the bar that was not where the caret was.
 * One non-overlapping enumeration now feeds the count, the marks and navigation alike.
 *
 * Keeping it in a field is also what stops a rescan on every cursor movement: only a
 * document edit or a new query can change the list.
 */
const findMatchesField = StateField.define<FindMatchState>({
  create: () => EMPTY_MATCH_STATE,
  update(state, transaction) {
    const queryChanged = transaction.effects.some((effect) => effect.is(setSearchQuery));
    let matches = state.matches;
    let activeIndex = state.activeIndex;
    if (queryChanged || transaction.docChanged) {
      matches = collectMatches(transaction.state);
      activeIndex = queryChanged ? null : relocateActive(state, transaction, matches);
    }
    for (const effect of transaction.effects) {
      if (effect.is(setActiveMatch)) {
        activeIndex = effect.value;
      }
    }
    if (matches === state.matches && activeIndex === state.activeIndex) {
      return state;
    }
    return { matches, activeIndex };
  },
  provide: (field) => EditorView.decorations.from(field, buildMatchDecorations),
});

function collectMatches(state: EditorState): readonly Match[] {
  const query = getSearchQuery(state);
  if (!query.valid) {
    return [];
  }
  const found: Match[] = [];
  // `SearchQuery.getCursor` is typed as an Iterator, not an Iterable, so no for..of.
  const cursor: Iterator<Match> = query.getCursor(state);
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    found.push({ from: step.value.from, to: step.value.to });
    if (found.length >= MATCH_COUNT_LIMIT) {
      break;
    }
  }
  return found;
}

/**
 * Keeps the active mark on the same text after an edit, without moving the caret: the
 * user may be typing in the document with the bar open.
 */
function relocateActive(
  previous: FindMatchState,
  transaction: Transaction,
  matches: readonly Match[],
): number | null {
  if (previous.activeIndex === null || matches.length === 0) {
    return null;
  }
  const active = previous.matches[previous.activeIndex];
  if (!active) {
    return null;
  }
  const from = transaction.changes.mapPos(active.from, 1);
  return indexAtOrAfter(matches, from) ?? matches.length - 1;
}

/** The first match the position has not passed yet, or null when it is past them all. */
function indexAtOrAfter(matches: readonly Match[], position: number): number | null {
  const index = matches.findIndex((match) => match.to > position);
  return index === -1 ? null : index;
}

function buildMatchDecorations({ matches, activeIndex }: FindMatchState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const [index, match] of matches.entries()) {
    builder.add(match.from, match.to, index === activeIndex ? ACTIVE_MATCH_MARK : MATCH_MARK);
  }
  return builder.finish();
}

/**
 * Find over a CodeMirror document, for the file pane's editor and read-only source view.
 *
 * CodeMirror already owns the query state; what it does not give us is highlights,
 * because its own highlighter paints nothing while its search panel is closed and we
 * never open that panel. So the query goes in through `setSearchQuery` and the marks
 * come back out of an app-owned decoration field. Navigation is ours too — the built-in
 * `findNext`/`findPrevious` commands search from the end of the selection, which walks
 * the active match forward by one on every keystroke.
 *
 * The active match is also the editor selection; closing the bar collapses it to a
 * caret at the match, so the user keeps their place without a lingering selection.
 */
export function createCodeMirrorFindEngine(view: EditorView): FindEngine {
  const listeners = new Set<(result: FindResult) => void>();
  const slot = configureFindView(view);

  /**
   * Where a re-run of the query starts looking: the active match's START, not the end of
   * the selection. Typing another character has to be able to extend the match the user
   * is standing on rather than skip past it.
   */
  let anchor: number | null = null;

  function matchState(): FindMatchState {
    return view.state.field(findMatchesField);
  }

  function emit(): void {
    const { matches, activeIndex } = matchState();
    const result: FindResult = { count: matches.length, activeIndex };
    for (const listener of listeners) {
      listener(result);
    }
  }
  slot.notify = emit;

  function searchOrigin(): number {
    if (anchor !== null) {
      return anchor;
    }
    const selection = view.state.selection.main;
    // Cmd+F with a word selected must activate that word, not the one after it.
    if (!selection.empty) {
      return selection.from;
    }
    return view.visibleRanges[0]?.from ?? selection.from;
  }

  function activate(index: number | null): void {
    const match = index === null ? null : matchState().matches[index];
    if (!match) {
      view.dispatch({ effects: setActiveMatch.of(null) });
      return;
    }
    anchor = match.from;
    view.dispatch({
      selection: EditorSelection.single(match.from, match.to),
      effects: [
        setActiveMatch.of(index),
        EditorView.scrollIntoView(EditorSelection.range(match.from, match.to), { y: "center" }),
      ],
    });
  }

  function step(delta: 1 | -1): void {
    const { matches, activeIndex } = matchState();
    activate(stepActiveIndex({ activeIndex, count: matches.length, delta }));
  }

  function applyQuery(search: string): void {
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({ search, caseSensitive: false, literal: true })),
    });
  }

  return {
    setQuery(query) {
      applyQuery(query);
      const { matches } = matchState();
      if (matches.length === 0) {
        // A query being typed passes through states that match nothing. Leaving the
        // caret alone is what lets the next character resume from the same place.
        return;
      }
      activate(indexAtOrAfter(matches, searchOrigin()) ?? 0);
    },

    next() {
      step(1);
    },

    previous() {
      step(-1);
    },

    clear() {
      const { matches, activeIndex } = matchState();
      const active = activeIndex === null ? null : matches[activeIndex];
      const selection = view.state.selection.main;
      // The active match doubles as the editor selection. Left in place after the bar
      // closes it becomes a live document selection once focus returns to the editor,
      // and react-native-web's responder treats the next press anywhere as a
      // selection gesture and swallows it. A collapsed caret at the match keeps the
      // user's place without that side effect.
      if (active && selection.from === active.from && selection.to === active.to) {
        view.dispatch({ selection: EditorSelection.cursor(active.from) });
      }
      anchor = null;
      applyQuery("");
    },

    subscribe(listener) {
      listeners.add(listener);
      const { matches, activeIndex } = matchState();
      listener({ count: matches.length, activeIndex });
      return () => {
        listeners.delete(listener);
      };
    },

    dispose() {
      if (slot.notify === emit) {
        slot.notify = null;
      }
      // Safe even once the view is destroyed: CodeMirror absorbs the transaction.
      applyQuery("");
      listeners.clear();
    },
  };
}

interface FindViewSlot {
  notify: (() => void) | null;
}

/**
 * The match field and update listener are appended to the view's config once. Appending
 * them per engine would stack duplicates on a view that outlives its engine, and
 * `appendConfig` has no counterpart that removes them again.
 */
const configuredViews = new WeakMap<EditorView, FindViewSlot>();

function configureFindView(view: EditorView): FindViewSlot {
  const existing = configuredViews.get(view);
  if (existing) {
    return existing;
  }
  const slot: FindViewSlot = { notify: null };
  configuredViews.set(view, slot);
  view.dispatch({
    effects: StateEffect.appendConfig.of([
      findMatchesField,
      EditorView.updateListener.of((update) => {
        // `false` because the field does not exist yet in the state this very
        // transaction is appending it to.
        const before = update.startState.field(findMatchesField, false);
        if (before !== update.state.field(findMatchesField, false)) {
          slot.notify?.();
        }
      }),
    ]),
  });
  return slot;
}
