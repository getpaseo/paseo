/** Native inputs retain their platform clipboard handling. */
export function readLinkedClipboardText(
  _clipboard: Pick<DataTransfer, "getData"> | null,
): string | null {
  return null;
}
