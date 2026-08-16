import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import type { SelectedTextComposerAttachment } from "@/attachments/types";
import type { AssistantSelectionAnnotation, SelectedTextAnnotationEdit } from "./types";

interface AssistantSelectionCopySurfaceProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  visible?: boolean;
  onCommentSelection?: (annotation: AssistantSelectionAnnotation) => void;
  addToCommentLabel?: string;
  addToConversationLabel?: string;
  commentPlaceholder?: string;
  saveCommentLabel?: string;
  cancelCommentLabel?: string;
  selectedTextAnnotationToEdit?: {
    id: string;
    text: string;
    sourceMessageId?: string;
    occurrence?: number;
    comment?: string;
  } | null;
  selectedTextAnnotations?: readonly SelectedTextComposerAttachment[];
  onOpenAnnotation?: (annotation: SelectedTextComposerAttachment) => void;
  onEditComment?: (input: SelectedTextAnnotationEdit) => void;
  onDismissEditComment?: () => void;
}

export function AssistantSelectionCopySurface({
  children,
  style,
}: AssistantSelectionCopySurfaceProps) {
  return <View style={style}>{children}</View>;
}
