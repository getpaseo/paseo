export interface PiRewindNavigator {
  navigateTree(targetId: string): Promise<unknown>;
}

export async function revertPiConversation(input: {
  messageId: string;
  navigator: PiRewindNavigator;
}): Promise<void> {
  const targetId = input.messageId.trim();
  if (!targetId) {
    throw new Error("Pi rewind requires a user message id");
  }
  await input.navigator.navigateTree(targetId);
}
