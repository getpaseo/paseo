import { CodeMirrorRuntime } from "./runtime";
import {
  parseSourceEditorHostMessage,
  type SourceEditorBridgeMessage,
  type SourceEditorHostMessage,
} from "./bridge-protocol";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage?: (data: string) => void };
    __PASEO_SOURCE_EDITOR_RECEIVE__?: (message: string) => void;
  }
}

function send(message: SourceEditorBridgeMessage): void {
  window.ReactNativeWebView?.postMessage?.(JSON.stringify(message));
}

class SourceEditorWebViewBridge {
  private runtime: CodeMirrorRuntime | null = null;
  private editorKey: string | null = null;

  receive = (rawMessage: string): void => {
    const message = parseSourceEditorHostMessage(rawMessage);
    if (!message) return;
    if (message.type === "mount") {
      this.mount(message);
      return;
    }
    if (message.editorKey !== this.editorKey) return;
    switch (message.type) {
      case "replaceDocument":
        this.runtime?.replaceDocument(message.document);
        break;
      case "configure":
        this.runtime?.configure(message.configuration);
        break;
      case "reveal":
        this.runtime?.reveal(message);
        break;
      case "destroy":
        this.destroy();
        break;
    }
  };

  private mount(message: Extract<SourceEditorHostMessage, { type: "mount" }>): void {
    this.destroy();
    this.editorKey = message.editorKey;
    const runtime = new CodeMirrorRuntime();
    this.runtime = runtime;
    runtime.mount({
      host,
      document: message.document,
      configuration: message.configuration,
      callbacks: {
        onChange: (changes) => send({ type: "change", editorKey: message.editorKey, changes }),
        onSave: () => send({ type: "save", editorKey: message.editorKey }),
        onCursorChange: (position) =>
          send({ type: "cursor", editorKey: message.editorKey, ...position }),
        onVimModeChange: (mode) => send({ type: "vimMode", editorKey: message.editorKey, mode }),
      },
    });
    send({ type: "ready", editorKey: message.editorKey });
  }

  private destroy(): void {
    this.runtime?.destroy();
    this.runtime = null;
    this.editorKey = null;
  }
}

const root = document.createElement("div");
root.id = "source-editor-root";
const host = document.createElement("div");
host.id = "source-editor-host";
root.appendChild(host);
document.body.appendChild(root);

const bridge = new SourceEditorWebViewBridge();
window.__PASEO_SOURCE_EDITOR_RECEIVE__ = bridge.receive;
send({ type: "bridgeReady" });
