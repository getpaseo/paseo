import type { SourceEditorBridgeMessage } from "./codemirror/bridge-protocol";
import type { SourceEditorPosition } from "./contract";
import { SourceDocumentMirror } from "./document-mirror";

interface SourceEditorControllerCallbacks {
  onChange(document: string): void;
  onSave(): void;
  onCursorChange(position: SourceEditorPosition): void;
  onVimModeChange(mode: string | null): void;
}

export class SourceEditorController {
  private readonly editorKey: string;
  private readonly mirror: SourceDocumentMirror;
  private readonly callbacks: SourceEditorControllerCallbacks;

  constructor(input: {
    editorKey: string;
    document: string;
    callbacks: SourceEditorControllerCallbacks;
  }) {
    this.editorKey = input.editorKey;
    this.mirror = new SourceDocumentMirror(input.document);
    this.callbacks = input.callbacks;
  }

  getRuntimeDocument(): string {
    return this.mirror.getRuntimeDocument();
  }

  replaceDocument(document: string): string | null {
    return this.mirror.replace(document) ? this.mirror.getRuntimeDocument() : null;
  }

  receive(message: SourceEditorBridgeMessage): boolean {
    if (message.type === "bridgeReady" || message.editorKey !== this.editorKey) return false;
    switch (message.type) {
      case "ready":
        return true;
      case "change": {
        let document: string;
        try {
          document = this.mirror.apply(message.changes);
        } catch {
          return false;
        }
        this.callbacks.onChange(document);
        return true;
      }
      case "cursor":
        this.callbacks.onCursorChange({ line: message.line, column: message.column });
        return true;
      case "save":
        this.callbacks.onSave();
        return true;
      case "vimMode":
        this.callbacks.onVimModeChange(message.mode);
        return true;
    }
  }
}
