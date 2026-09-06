// Expo's web fallback reports success even when document.execCommand returns
// false. Use the browser promise so the SDK can promise success or rejection.
export async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard) throw new Error("Clipboard copy is unavailable in this browser");
  await navigator.clipboard.writeText(text);
}
