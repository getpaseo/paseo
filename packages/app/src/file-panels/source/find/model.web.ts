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

/** Which corner of the editor the floating Find widget occupies. */
export type FindPlacement = "top" | "bottom";

/** CodeMirror owns query, matching, selection, replacement, and panel lifetime. */
export class FileFindModel {
  private view: EditorView | null = null;
  private listeners = new Set<() => void>();
  private matches: Array<{ from: number; to: number }> = [];
  private widget: HTMLElement | null = null;
  private widgetResize: ResizeObserver | null = null;
  private snapshot = {
    open: false,
    placement: "top" as FindPlacement,
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
    // The widget floats over the editor as a sibling overlay, so this panel is an
    // inert placeholder that only reports whether Find is open. Hide the placeholder
    // itself, never the shared panel container — Go to line's dialog lives there too.
    EditorView.theme({ ".cm-panel.paseo-file-find": { display: "none" } }),
    // Reveal matches clear of the widget instead of underneath it.
    EditorView.scrollMargins.of((view) => {
      const clearance = this.clearance(view);
      if (!clearance) return null;
      return this.snapshot.placement === "top" ? { top: clearance } : { bottom: clearance };
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

  /**
   * The widget renders outside CodeMirror, so the editor cannot see it. Handing the
   * node here lets this model — which already owns reveal — measure the obstruction.
   */
  readonly setWidgetNode = (node: HTMLElement | null) => {
    if (this.widget === node) return;
    this.widgetResize?.disconnect();
    this.widgetResize = null;
    this.widget = node;
    if (!node) return;
    this.widgetResize = new ResizeObserver(() => this.reposition());
    this.widgetResize.observe(node);
    this.reposition();
  };

  private createPanel(view: EditorView): Panel {
    this.view = view;
    const dom = document.createElement("div");
    dom.className = "paseo-file-find";
    return {
      dom,
      top: true,
      mount: () => {
        this.snapshot = { ...this.snapshot, open: true, placement: "top" };
        this.update(view, true);
      },
      update: (update: ViewUpdate) => {
        const queryChanged = !getSearchQuery(update.startState).eq(getSearchQuery(update.state));
        if (
          update.docChanged ||
          update.selectionSet ||
          queryChanged ||
          update.geometryChanged ||
          update.viewportChanged
        )
          this.update(view, update.docChanged || queryChanged);
      },
      destroy: () => {
        this.snapshot = { ...this.snapshot, open: false, placement: "top" };
        this.publish();
      },
    };
  }

  /** Vertical space the widget takes out of the editor, including its inset. */
  private clearance(view: EditorView): number {
    const widget = this.widget;
    if (!widget || !this.snapshot.open) return 0;
    const box = widget.getBoundingClientRect();
    if (!box.height) return 0;
    const editor = view.scrollDOM.getBoundingClientRect();
    const clearance =
      this.snapshot.placement === "top" ? box.bottom - editor.top : editor.bottom - box.top;
    return Math.max(0, clearance);
  }

  /**
   * Move the widget to the opposite corner when it sits on top of the active match
   * and the editor has no scroll range left to reveal it. Placement only changes
   * when the current corner collides, so navigating matches never makes it bounce.
   *
   * Measurement runs through `requestMeasure` because CodeMirror refuses layout
   * reads while an update is in progress, and every caller here sits inside one.
   */
  private reposition() {
    const view = this.view;
    if (!view || !this.widget || !this.snapshot.open) return;
    view.requestMeasure<FindPlacement>({
      key: this,
      read: () => this.measurePlacement(view),
      write: (placement) => {
        if (placement === this.snapshot.placement) return;
        this.snapshot = { ...this.snapshot, placement };
        this.publish();
      },
    });
  }

  private measurePlacement(view: EditorView): FindPlacement {
    const current = this.snapshot.placement;
    const widget = this.widget;
    if (!widget) return current;
    const selection = view.state.selection.main;
    if (selection.empty) return current;
    const from = view.coordsAtPos(selection.from);
    const to = view.coordsAtPos(selection.to);
    if (!from || !to) return current;
    const clearance = this.clearance(view);
    if (!clearance) return current;
    const box = widget.getBoundingClientRect();
    const editor = view.scrollDOM.getBoundingClientRect();
    const match = {
      top: Math.min(from.top, to.top),
      bottom: Math.max(from.bottom, to.bottom),
      right: Math.max(from.right, to.right),
    };
    const hits = (placement: FindPlacement) => {
      if (match.right <= box.left) return false;
      return placement === "top"
        ? match.top < editor.top + clearance && match.bottom > editor.top
        : match.bottom > editor.bottom - clearance && match.top < editor.bottom;
    };
    if (!hits(current)) return current;
    const other: FindPlacement = current === "top" ? "bottom" : "top";
    return hits(other) ? current : other;
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
    this.reposition();
  }

  private publish() {
    for (const listener of this.listeners) listener();
  }
}
