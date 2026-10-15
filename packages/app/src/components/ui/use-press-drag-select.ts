import { inertPressDragSelection, type PressDragOptions } from "./press-drag-select-context";

export function usePressDragSelect(_options: PressDragOptions) {
  return inertPressDragSelection;
}
