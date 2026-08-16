export interface AssistantSelectionAnnotation {
  text: string;
  sourceMessageId?: string;
  occurrence?: number;
  comment: string;
  attachmentId?: string;
}

export interface SelectedTextAnnotationEdit {
  attachmentId: string;
  comment: string;
}
