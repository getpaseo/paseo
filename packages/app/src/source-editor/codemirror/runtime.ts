import { Annotation, Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { getLanguageForFile } from "@getpaseo/highlight";
import { getCM, vim } from "@replit/codemirror-vim";
import { isRenderedMarkdownFile } from "@/components/file-pane-render-mode";
import type {
  SourceChange,
  SourceEditorConfiguration,
  SourceEditorPosition,
  SourceEditorSelectionTarget,
} from "../contract";
import { sourceEditorBaseExtensions, sourceEditorTheme } from "./configuration";

interface CodeMirrorRuntimeCallbacks {
  onChange(changes: readonly SourceChange[]): void;
  onSave(): void;
  onCursorChange(position: SourceEditorPosition): void;
  onVimModeChange(mode: string | null): void;
}

const remoteUpdate = Annotation.define<boolean>();

export class CodeMirrorRuntime {
  private readonly languageCompartment = new Compartment();
  private readonly wrappingCompartment = new Compartment();
  private readonly themeCompartment = new Compartment();
  private readonly vimCompartment = new Compartment();
  private view: EditorView | null = null;
  private callbacks: CodeMirrorRuntimeCallbacks | null = null;
  private vimModeListener: ((event: { mode?: string }) => void) | null = null;

  mount(input: {
    host: HTMLElement;
    document: string;
    configuration: SourceEditorConfiguration;
    callbacks: CodeMirrorRuntimeCallbacks;
  }): void {
    this.destroy();
    this.callbacks = input.callbacks;
    this.view = new EditorView({
      parent: input.host,
      state: EditorState.create({
        doc: input.document,
        extensions: [
          this.vimCompartment.of(input.configuration.vimEnabled ? vim() : []),
          ...sourceEditorBaseExtensions(() => this.callbacks?.onSave()),
          this.languageCompartment.of(languageForFile(input.configuration.filename)),
          this.wrappingCompartment.of(wrappingForFile(input.configuration.filename)),
          this.themeCompartment.of(sourceEditorTheme(input.configuration.theme)),
          EditorView.updateListener.of((update) => this.receiveUpdate(update)),
        ],
      }),
    });
    this.configureVim(input.configuration.vimEnabled);
    this.reportCursor();
  }

  replaceDocument(document: string): void {
    const view = this.view;
    if (!view || view.state.doc.toString() === document) return;
    const head = Math.min(view.state.selection.main.head, document.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: document },
      selection: { anchor: head },
      annotations: [remoteUpdate.of(true), Transaction.addToHistory.of(false)],
    });
  }

  configure(configuration: SourceEditorConfiguration): void {
    const view = this.view;
    if (!view) return;
    this.removeVimModeListener();
    view.dispatch({
      effects: [
        this.languageCompartment.reconfigure(languageForFile(configuration.filename)),
        this.wrappingCompartment.reconfigure(wrappingForFile(configuration.filename)),
        this.themeCompartment.reconfigure(sourceEditorTheme(configuration.theme)),
        this.vimCompartment.reconfigure(configuration.vimEnabled ? vim() : []),
      ],
    });
    this.configureVim(configuration.vimEnabled);
  }

  reveal(target: SourceEditorSelectionTarget): void {
    const view = this.view;
    if (!view) return;
    const lineStart = Math.min(target.lineStart, view.state.doc.lines);
    const lineEnd = Math.min(target.lineEnd ?? lineStart, view.state.doc.lines);
    const from = view.state.doc.line(lineStart).from;
    const to = view.state.doc.line(Math.max(lineStart, lineEnd)).to;
    view.dispatch({
      selection: { anchor: from, head: lineEnd > lineStart ? to : from },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
  }

  destroy(): void {
    this.removeVimModeListener();
    this.view?.destroy();
    this.view = null;
    this.callbacks = null;
  }

  private receiveUpdate(update: ViewUpdate): void {
    if (
      update.docChanged &&
      !update.transactions.some((transaction) => transaction.annotation(remoteUpdate))
    ) {
      const changes: SourceChange[] = [];
      update.changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
        changes.push({ from, to, insert: inserted.toString() });
      });
      this.callbacks?.onChange(changes);
    }
    if (update.selectionSet || update.docChanged) this.reportCursor();
  }

  private reportCursor(): void {
    const view = this.view;
    if (!view) return;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    this.callbacks?.onCursorChange({ line: line.number, column: head - line.from + 1 });
  }

  private configureVim(enabled: boolean): void {
    if (!enabled || !this.view) {
      this.callbacks?.onVimModeChange(null);
      return;
    }
    const cm = getCM(this.view);
    if (!cm) return;
    this.vimModeListener = (event) =>
      this.callbacks?.onVimModeChange((event.mode ?? "normal").toUpperCase());
    cm.on("vim-mode-change", this.vimModeListener);
    this.callbacks?.onVimModeChange("NORMAL");
  }

  private removeVimModeListener(): void {
    if (!this.view || !this.vimModeListener) return;
    getCM(this.view)?.off("vim-mode-change", this.vimModeListener);
    this.vimModeListener = null;
  }
}

function languageForFile(filename: string) {
  return getLanguageForFile(filename)?.extension ?? [];
}

function wrappingForFile(filename: string) {
  return isRenderedMarkdownFile(filename) ? EditorView.lineWrapping : [];
}
