/**
 * Web-only rich-text editor for the chat composer, built on Lexical.
 *
 * Why: the previous `TextInput` was plain text, so markdown tokens like
 * `**bold**` or mention tokens like `<@id>` showed as raw characters until
 * the message was sent. This component:
 *   - live-formats markdown while you type (**bold** → bold);
 *   - renders `@mentions` as styled chips inside the editor;
 *   - serializes back to markdown + `<@id>` tokens on submit so the wire
 *     format is unchanged (backend + older clients keep working).
 *
 * It exposes a `value` / `onChangeText` / `onSubmit` API so the outer
 * `Composer` (uploads, slash commands, reply quotes) stays the same.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { TRANSFORMERS, $convertToMarkdownString, $convertFromMarkdownString } from "@lexical/markdown";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListItemNode, ListNode } from "@lexical/list";
import { LinkNode } from "@lexical/link";
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $createTextNode,
  KEY_ENTER_COMMAND,
  COMMAND_PRIORITY_HIGH,
  type LexicalEditor,
  DecoratorNode,
  type EditorConfig,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
  $applyNodeReplacement,
} from "lexical";

// ─── Mention node (renders `<@id>` as a chip in the editor) ─────────────────

export type SerializedMentionNode = Spread<
  { userId: string; name: string; type: "mention"; version: 1 },
  SerializedLexicalNode
>;

export class MentionNode extends DecoratorNode<JSX.Element> {
  __userId: string;
  __name: string;

  static getType(): string {
    return "mention";
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__userId, node.__name, node.__key);
  }

  constructor(userId: string, name: string, key?: NodeKey) {
    super(key);
    this.__userId = userId;
    this.__name = name;
  }

  createDOM(): HTMLElement {
    // Wrapper span so React portal mounts into it. ContentEditable=false so
    // the cursor skips over the whole chip as a single unit.
    const span = document.createElement("span");
    span.setAttribute("contenteditable", "false");
    span.style.display = "inline-block";
    return span;
  }

  updateDOM(): boolean {
    return false;
  }

  static importJSON(json: SerializedMentionNode): MentionNode {
    return $createMentionNode(json.userId, json.name);
  }

  exportJSON(): SerializedMentionNode {
    return {
      type: "mention",
      version: 1,
      userId: this.__userId,
      name: this.__name,
    };
  }

  /** Markdown serialization: always round-trips to `<@id>` for the wire. */
  getTextContent(): string {
    return `<@${this.__userId}>`;
  }

  isInline(): true {
    return true;
  }

  isIsolated(): true {
    return true;
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): JSX.Element {
    return (
      <span
        style={{
          display: "inline-block",
          padding: "0 6px",
          margin: "0 1px",
          borderRadius: 4,
          background: "rgba(196, 25, 139, 0.18)",
          color: "#f472c8",
          fontWeight: 600,
          fontSize: 13,
          lineHeight: "20px",
          verticalAlign: "baseline",
        }}
      >
        @{this.__name}
      </span>
    );
  }
}

export function $createMentionNode(userId: string, name: string): MentionNode {
  return $applyNodeReplacement(new MentionNode(userId, name));
}

// ─── Submit-on-Enter plugin ─────────────────────────────────────────────────

function SubmitOnEnterPlugin({ onSubmit }: { onSubmit: () => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        const e = event as KeyboardEvent | null;
        if (!e) return false;
        if (e.shiftKey) return false; // Shift+Enter = newline
        e.preventDefault();
        onSubmit();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onSubmit]);
  return null;
}

// ─── External value sync (controlled-ish) ───────────────────────────────────

function ValueSyncPlugin({ value, lastInjectedRef }: { value: string; lastInjectedRef: React.MutableRefObject<string> }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    // Only push external `value` into the editor when it diverges from what
    // we last emitted upward. Otherwise we'd fight the user's own typing.
    if (value === lastInjectedRef.current) return;
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      $convertFromMarkdownString(value, TRANSFORMERS);
    });
    lastInjectedRef.current = value;
  }, [editor, value, lastInjectedRef]);
  return null;
}

// ─── Public component ───────────────────────────────────────────────────────

export interface RichTextInputHandle {
  focus: () => void;
  insertMention: (userId: string, name: string) => void;
}

interface RichTextInputProps {
  value: string;
  placeholder?: string;
  onChangeText: (next: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  minHeight?: number;
  maxHeight?: number;
}

export const RichTextInput = forwardRef<RichTextInputHandle, RichTextInputProps>(
  function RichTextInput(
    { value, placeholder, onChangeText, onSubmit, disabled, minHeight = 38, maxHeight = 140 },
    ref,
  ) {
    const editorRef = useRef<LexicalEditor | null>(null);
    const lastInjectedRef = useRef<string>(value);

    const initialConfig = useMemo(
      () => ({
        namespace: "HubcodeComposer",
        nodes: [HeadingNode, QuoteNode, ListItemNode, ListNode, LinkNode, MentionNode],
        theme: {
          paragraph: "hubcode-editor-paragraph",
          text: {
            bold: "hubcode-editor-bold",
            italic: "hubcode-editor-italic",
            strikethrough: "hubcode-editor-strike",
            code: "hubcode-editor-code",
          },
        },
        onError(err: Error) {
          console.error("[Lexical]", err);
        },
        editable: !disabled,
      }),
      [disabled],
    );

    useImperativeHandle(ref, () => ({
      focus() {
        editorRef.current?.focus();
      },
      insertMention(userId: string, name: string) {
        const editor = editorRef.current;
        if (!editor) return;
        editor.update(() => {
          const sel = $getSelection();
          if (!$isRangeSelection(sel)) return;
          // Strip the trailing trigger "@query" that the user typed so the
          // chip replaces it.
          const anchor = sel.anchor;
          const node = anchor.getNode();
          const text = node.getTextContent();
          const caret = anchor.offset;
          const before = text.slice(0, caret);
          const atIdx = before.lastIndexOf("@");
          if (atIdx >= 0 && "setTextContent" in node && typeof (node as { setTextContent?: unknown }).setTextContent === "function") {
            (node as { setTextContent: (v: string) => void }).setTextContent(
              before.slice(0, atIdx) + text.slice(caret),
            );
          }
          const mention = $createMentionNode(userId, name);
          sel.insertNodes([mention]);
          sel.insertNodes([$createTextNode(" ")]);
        });
      },
    }));

    const handleChange = useCallback(
      (editorState: ReturnType<LexicalEditor["getEditorState"]>) => {
        editorState.read(() => {
          const md = $convertToMarkdownString(TRANSFORMERS);
          if (md !== lastInjectedRef.current) {
            lastInjectedRef.current = md;
            onChangeText(md);
          }
        });
      },
      [onChangeText],
    );

    return (
      <div
        style={{
          flex: 1,
          position: "relative",
          minHeight,
          maxHeight,
          overflowY: "auto",
        }}
      >
        <LexicalComposer initialConfig={initialConfig}>
          <EditorRefGrabber editorRef={editorRef} />
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                className="hubcode-editor-content"
                aria-placeholder={placeholder ?? ""}
                placeholder={
                  <div
                    style={{
                      position: "absolute",
                      top: 9,
                      left: 12,
                      pointerEvents: "none",
                      color: "var(--hubcode-muted, #94a3b8)",
                      fontSize: 14,
                    }}
                  >
                    {placeholder}
                  </div>
                }
                style={{
                  outline: "none",
                  minHeight,
                  padding: "9px 12px",
                  fontSize: 14,
                  lineHeight: "20px",
                  color: "inherit",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              />
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <HistoryPlugin />
          <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
          <OnChangePlugin onChange={handleChange} />
          <SubmitOnEnterPlugin onSubmit={onSubmit} />
          <ValueSyncPlugin value={value} lastInjectedRef={lastInjectedRef} />
        </LexicalComposer>
      </div>
    );
  },
);

function EditorRefGrabber({ editorRef }: { editorRef: React.MutableRefObject<LexicalEditor | null> }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editorRef.current = editor;
  }, [editor, editorRef]);
  return null;
}
