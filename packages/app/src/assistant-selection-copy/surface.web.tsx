import {
  useCallback,
  type ClipboardEvent,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { createAssistantSelectionClipboardContent } from "./content.web";

interface AssistantSelectionCopySurfaceProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** The surface view, which find registers as the transcript pane's root. */
  ref?: Ref<View>;
}

const DISPLAY_CONTENTS: CSSProperties = { display: "contents" };

export function AssistantSelectionCopySurface({
  children,
  style,
  ref,
}: AssistantSelectionCopySurfaceProps) {
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
    <div onCopy={handleCopy} style={DISPLAY_CONTENTS}>
      <View ref={ref} style={style}>
        {children}
      </View>
    </div>
  );
}
