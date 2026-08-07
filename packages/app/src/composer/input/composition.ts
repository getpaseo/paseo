export function installComposerCompositionHandlers(
  textarea: HTMLTextAreaElement,
  valueRef: { current: string },
  onChangeText: (text: string) => void,
  setIsComposing: (isComposing: boolean) => void,
): () => void {
  let compositionEndTimer: ReturnType<typeof setTimeout> | null = null;

  const handleCompositionStart = () => {
    setIsComposing(true);
  };
  const handleCompositionEnd = () => {
    const nextValue = textarea.value;
    if (nextValue !== valueRef.current) {
      valueRef.current = nextValue;
      onChangeText(nextValue);
    }
    if (compositionEndTimer !== null) clearTimeout(compositionEndTimer);
    compositionEndTimer = setTimeout(() => setIsComposing(false), 0);
  };

  textarea.addEventListener("compositionstart", handleCompositionStart);
  textarea.addEventListener("compositionend", handleCompositionEnd);
  return () => {
    if (compositionEndTimer !== null) clearTimeout(compositionEndTimer);
    textarea.removeEventListener("compositionstart", handleCompositionStart);
    textarea.removeEventListener("compositionend", handleCompositionEnd);
  };
}
