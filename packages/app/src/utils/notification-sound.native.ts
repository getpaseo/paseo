export async function playNotificationSound(): Promise<boolean> {
  // Local notifications are remote-push-only on native; no local sound.
  return false;
}
