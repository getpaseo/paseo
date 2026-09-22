import { EditorView, keymap } from "@codemirror/view";
import type { LanguageActions, CodeTarget } from "./actions";

export function editorCodeTarget(
  view: EditorView,
  path: string,
  offset = view.state.selection.main.from,
): CodeTarget {
  const line = view.state.doc.lineAt(offset);
  return { path, position: { line: line.number - 1, character: offset - line.from } };
}
export function editorLanguageExtension(actions: LanguageActions, path: string) {
  return [
    EditorView.updateListener.of((update) => {
      if (update.docChanged) actions.dismiss();
    }),
    keymap.of([
      {
        key: "Escape",
        run: () => {
          if (actions.getSnapshot().kind !== "hover") return false;
          actions.close();
          return true;
        },
      },
      {
        key: "F12",
        run: (view) => {
          void actions.run(editorCodeTarget(view, path), "definition", undefined, () =>
            view.focus(),
          );
          return true;
        },
      },
      {
        key: "Shift-F12",
        run: (view) => {
          void actions.run(editorCodeTarget(view, path), "references", undefined, () =>
            view.focus(),
          );
          return true;
        },
      },
      {
        key: "Alt-F12",
        run: (view) => {
          const position = view.coordsAtPos(view.state.selection.main.head);
          void actions.run(
            editorCodeTarget(view, path),
            "hover",
            position ? { x: position.left, y: position.bottom } : undefined,
            () => view.focus(),
          );
          return true;
        },
      },
    ]),
    EditorView.domEventHandlers({
      mousemove(event, view) {
        if (event.buttons) {
          actions.dismissHover();
          return false;
        }
        const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (offset === null) actions.leaveHover();
        else
          actions.hover(editorCodeTarget(view, path, offset), {
            x: event.clientX,
            y: event.clientY,
          });
        return false;
      },
      mouseleave(event) {
        if (
          event.relatedTarget instanceof Element &&
          event.relatedTarget.closest('[data-testid="code-language-hover"]')
        )
          return false;
        actions.leaveHover();
        return false;
      },
      mousedown(event, view) {
        if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
        const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (offset === null) return false;
        event.preventDefault();
        void actions.run(editorCodeTarget(view, path, offset), "definition", undefined, () =>
          view.focus(),
        );
        return true;
      },
      contextmenu(event, view) {
        const offset = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const selection = view.state.selection.main;
        if (
          offset !== null &&
          (selection.empty || offset < selection.from || offset > selection.to)
        )
          view.dispatch({ selection: { anchor: offset } });
        return false;
      },
    }),
  ];
}
