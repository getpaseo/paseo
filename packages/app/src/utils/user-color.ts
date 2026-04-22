// Deterministic per-user color for shared-session UI (cursors, typing bubbles).
// Same userId always maps to the same hue so every viewer sees consistent colors.

export function userColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 75%, 55%)`;
}
