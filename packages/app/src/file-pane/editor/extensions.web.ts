import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { createCodeMirrorHighlightStyle, type HighlightStyle } from "@getpaseo/highlight";

export interface EditorVisualTheme {
  colorScheme: "light" | "dark";
  background: string;
  foreground: string;
  cursor: string;
  foregroundMuted: string;
  border: string;
  selection: string;
  monoFont: string;
  codeFontSize: number;
  syntax: Record<HighlightStyle, string>;
  findMatch: string;
  findMatchActive: string;
}

/**
 * CodeMirror's search state without its panel.
 *
 * The app find bar drives the query through `setSearchQuery` and paints its own
 * decorations (find/file/codemirror-engine.web.ts), because the built-in highlighter
 * returns `Decoration.none` while the panel is closed. Only `scrollToMatch` is
 * borrowed, so a match lands centred like it does on the other find surfaces.
 */
export function editorSearchExtension() {
  return search({ scrollToMatch: (range) => EditorView.scrollIntoView(range, { y: "center" }) });
}

/**
 * The find keys belong to the app, not to CodeMirror. Left in place they would open
 * CodeMirror's own panel: `searchCommand` falls back to `openSearchPanel` whenever the
 * query is empty, which is exactly the state the editor is in before the bar is used.
 * Dropping `Mod-g` drops `Shift-Mod-g` with it — one binding carries both directions.
 */
const APP_OWNED_SEARCH_KEYS = new Set(["Mod-f", "Mod-g", "F3", "Escape"]);
const editorSearchKeymap = searchKeymap.filter(
  (binding) => !APP_OWNED_SEARCH_KEYS.has(binding.key ?? ""),
);

export function editorBaseExtensions(onSave: () => void) {
  return [
    lineNumbers(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    editorSearchExtension(),
    keymap.of([
      { key: "Mod-s", preventDefault: true, run: () => (onSave(), true) },
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
      ...editorSearchKeymap,
    ]),
  ];
}

export function editorTheme(theme: EditorVisualTheme) {
  return [
    EditorView.theme(
      {
        "&": {
          height: "100%",
          backgroundColor: theme.background,
          color: theme.foreground,
          fontFamily: theme.monoFont,
          fontSize: `${theme.codeFontSize}px`,
        },
        ".cm-scroller": {
          overflow: "auto",
          fontFamily: theme.monoFont,
          lineHeight: "1.45",
        },
        ".cm-content": { caretColor: theme.foreground, padding: "16px 0" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: theme.cursor },
        ".cm-gutters": {
          backgroundColor: theme.background,
          color: theme.foregroundMuted,
          borderRight: `1px solid ${theme.border}`,
        },
        ".cm-activeLine": { backgroundColor: "transparent" },
        ".cm-activeLineGutter": { backgroundColor: "transparent", color: theme.foreground },
        "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
          backgroundColor: theme.selection,
        },
        ".cm-selectionBackground, ::selection": {
          backgroundColor: theme.selection,
        },
        "&.cm-focused": { outline: "none" },
        ".cm-paseoFindMatch": { backgroundColor: theme.findMatch },
        ".cm-paseoFindMatchActive": { backgroundColor: theme.findMatchActive },
      },
      { dark: theme.colorScheme === "dark" },
    ),
    syntaxHighlighting(createCodeMirrorHighlightStyle(theme.syntax)),
  ];
}
