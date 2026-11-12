import {
  useCallback,
  useRef,
  type ClipboardEvent,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { createAssistantSelectionClipboardContent } from "./content.web";

interface AssistantSelectionCopySurfaceProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}

const DISPLAY_CONTENTS: CSSProperties = { display: "contents" };
const ASSISTANT_MESSAGE_SELECTOR = '[data-testid="assistant-message"]';

interface DragOrigin {
  pointerId: number;
  node: Text;
  offset: number;
  x: number;
  y: number;
}

function caretAtPoint(x: number, y: number): { node: Node; offset: number } | null {
  const caret = document.caretPositionFromPoint?.(x, y);
  if (caret) return { node: caret.offsetNode, offset: caret.offset };
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

function restoreCollapsedSelection(origin: DragOrigin, x: number, y: number): void {
  if (!origin.node.isConnected || origin.offset > origin.node.length) return;
  const selection = window.getSelection();
  if (!selection?.isCollapsed) return;
  const end = caretAtPoint(x, y);
  if (!end?.node.isConnected) return;
  // A drag can move the caret while Chromium leaves the native selection collapsed.
  selection.setBaseAndExtent(origin.node, origin.offset, end.node, end.offset);
}

export function AssistantSelectionCopySurface({
  children,
  style,
}: AssistantSelectionCopySurfaceProps) {
  const dragOrigin = useRef<DragOrigin | null>(null);
  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    dragOrigin.current = null;
    if (event.pointerType !== "mouse" || event.button !== 0 || !event.isPrimary) return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(ASSISTANT_MESSAGE_SELECTOR)) return;
    const caret = caretAtPoint(event.clientX, event.clientY);
    if (!(caret?.node instanceof Text)) return;
    dragOrigin.current = {
      pointerId: event.pointerId,
      node: caret.node,
      offset: caret.offset,
      x: event.clientX,
      y: event.clientY,
    };
  }, []);
  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const origin = dragOrigin.current;
    if (!origin || origin.pointerId !== event.pointerId || !(event.buttons & 1)) return;
    const x = event.clientX;
    const y = event.clientY;
    if (Math.hypot(x - origin.x, y - origin.y) < 4) return;
    queueMicrotask(() => restoreCollapsedSelection(origin, x, y));
  }, []);
  const handlePointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const origin = dragOrigin.current;
    dragOrigin.current = null;
    if (!origin || origin.pointerId !== event.pointerId) return;
    const x = event.clientX;
    const y = event.clientY;
    if (Math.hypot(x - origin.x, y - origin.y) < 4) return;
    requestAnimationFrame(() => restoreCollapsedSelection(origin, x, y));
  }, []);
  const handlePointerCancel = useCallback(() => {
    dragOrigin.current = null;
  }, []);
  const handleCopy = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
    const content = createAssistantSelectionClipboardContent(window.getSelection());
    if (!content) {
      return;
    }

    event.preventDefault();
    event.clipboardData.setData("text/plain", content.plainText);
    event.clipboardData.setData("text/html", content.html);
  }, []);

  return (
    <div
      onCopy={handleCopy}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      style={DISPLAY_CONTENTS}
    >
      <View style={style}>{children}</View>
    </div>
  );
}
