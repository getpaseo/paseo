import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, type Panel, type ViewUpdate } from "@codemirror/view";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchKeymap,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";

const MATCH_STATUS_LIMIT = 10_000;

/** CodeMirror owns query, matching, selection, replacement, and panel lifetime. */
export class FileFindModel {
  private view: EditorView | null = null;
  private listeners = new Set<() => void>();
  private matches: Array<{ from: number; to: number }> = [];
  private snapshot = {
    panel: null as HTMLElement | null,
    query: "",
    replacement: "",
    current: 0,
    total: 0,
    limited: false,
    readOnly: true,
  };
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.snapshot;

  readonly extension: Extension = [
    // The custom panel lives inside the editor's monospace subtree.
    EditorView.theme({
      ".paseo-file-find, .paseo-file-find *": { fontFamily: "var(--paseo-ui-font)" },
    }),
    search({ literal: true, top: true, createPanel: (view) => this.createPanel(view) }),
    EditorState.transactionExtender.of((transaction) => {
      // CodeMirror seeds every search-opening command from the selection. A
      // single-line field cannot represent CR/LF, so keep the previous query.
      const multilineSeed = transaction.effects.some(
        (effect) => effect.is(setSearchQuery) && /[\r\n]/.test(effect.value.search),
      );
      if (!multilineSeed) return null;
      return { effects: setSearchQuery.of(getSearchQuery(transaction.startState)) };
    }),
    keymap.of(searchKeymap.filter((binding) => binding.key !== "Mod-f")),
  ];

  readonly open = (view = this.view) => {
    if (view) openSearchPanel(view);
  };
  readonly close = () => {
    if (this.view) {
      closeSearchPanel(this.view);
      this.view.focus();
    }
  };
  readonly next = () => {
    if (this.view) findNext(this.view);
  };
  readonly previous = () => {
    if (this.view) findPrevious(this.view);
  };
  readonly replace = () => {
    if (this.view) replaceNext(this.view);
  };
  readonly replaceAll = () => {
    if (this.view) replaceAll(this.view);
  };
  readonly setReplacement = (replacement: string) =>
    this.setQuery(this.snapshot.query, replacement);
  readonly setSearch = (query: string) => {
    this.setQuery(query, this.snapshot.replacement);
    if (this.view && this.matches.length > 0) {
      this.view.dispatch({ selection: { anchor: this.view.state.selection.main.from } });
      findNext(this.view);
    }
  };

  private setQuery(query: string, replacement: string) {
    this.view?.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({ search: query, replace: replacement, literal: true }),
      ),
    });
  }

  private createPanel(view: EditorView): Panel {
    this.view = view;
    const dom = document.createElement("div");
    dom.className = "paseo-file-find";
    return {
      dom,
      top: true,
      mount: () => {
        this.snapshot = { ...this.snapshot, panel: dom };
        this.update(view, true);
      },
      update: (update: ViewUpdate) => {
        const queryChanged = !getSearchQuery(update.startState).eq(getSearchQuery(update.state));
        if (update.docChanged || update.selectionSet || queryChanged)
          this.update(view, update.docChanged || queryChanged);
      },
      destroy: () => {
        this.snapshot = { ...this.snapshot, panel: null };
        this.publish();
      },
    };
  }

  private update(view: EditorView, recount: boolean) {
    const query = getSearchQuery(view.state);
    let limited = this.snapshot.limited;
    if (recount) {
      this.matches = [];
      limited = false;
      if (query.valid) {
        const cursor = query.getCursor(view.state);
        for (let match = cursor.next(); !match.done; match = cursor.next()) {
          if (this.matches.length === MATCH_STATUS_LIMIT) {
            limited = true;
            break;
          }
          this.matches.push(match.value);
        }
      }
    }
    const selection = view.state.selection.main;
    const current =
      this.matches.findIndex(
        (match) => match.from === selection.from && match.to === selection.to,
      ) + 1;
    this.snapshot = {
      ...this.snapshot,
      query: query.search,
      replacement: query.replace,
      current,
      total: this.matches.length,
      limited,
      readOnly: view.state.readOnly,
    };
    this.publish();
  }

  private publish() {
    for (const listener of this.listeners) listener();
  }
}
