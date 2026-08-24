export async function returnToTimelineTail(input: {
  fetchTail: () => Promise<unknown>;
  scrollToBottom: () => void;
  onError: () => void;
  logError?: (message: string, error: unknown) => void;
}): Promise<void> {
  try {
    await input.fetchTail();
    input.scrollToBottom();
  } catch (error) {
    (input.logError ?? console.warn)("Failed to return to the live timeline tail", error);
    input.onError();
  }
}
