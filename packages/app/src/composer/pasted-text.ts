/** Native inputs retain their platform clipboard handling. */
export function pasteLinkedClipboardText(
  _input: HTMLElement,
  _clipboard: Pick<DataTransfer, "getData"> | null,
): boolean {
  return false;
}
