export interface PushRegistrationClient {
  readonly isConnected: boolean;
  registerPushToken(token: string): void;
  unregisterPushToken(token: string): Promise<void>;
}

export async function registerRotatedPushToken(input: {
  client: PushRegistrationClient;
  token: string | null;
  previousToken: string | null;
  supportsRevocation: boolean;
}): Promise<void> {
  if (!input.client.isConnected) return;
  // Install the replacement before revoking the old subscription.
  if (input.token) input.client.registerPushToken(input.token);
  if (input.supportsRevocation && input.previousToken && input.previousToken !== input.token) {
    await input.client.unregisterPushToken(input.previousToken);
  }
}
