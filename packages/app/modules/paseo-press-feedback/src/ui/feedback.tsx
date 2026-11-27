import type { Ref } from "react";
export interface RowFeedbackHandle {
  acknowledge(): Promise<void>;
}
export function RowFeedback(_props: { ref?: Ref<RowFeedbackHandle>; selected: boolean }) {
  return null;
}
