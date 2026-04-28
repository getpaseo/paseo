// LiveKit PreJoin is web-only; native still uses system device picker.
export interface PreJoinModalProps {
  visible: boolean;
  username: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function PreJoinModal({ visible, onConfirm }: PreJoinModalProps) {
  if (visible) {
    queueMicrotask(onConfirm);
  }
  return null;
}
