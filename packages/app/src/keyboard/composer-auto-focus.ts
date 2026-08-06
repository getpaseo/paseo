// Set when a hardware-keyboard shortcut navigates to a workspace on native,
// consumed by the composer of the workspace that becomes active so typing can
// continue without touching the screen. Time-boxed so a missed consume can't
// focus an input long after the navigation.
const VALIDITY_MS = 3000;

let requestedAt: number | null = null;

export function requestComposerAutoFocus(): void {
  requestedAt = Date.now();
}

export function consumeComposerAutoFocus(): boolean {
  if (requestedAt === null) return false;
  const valid = Date.now() - requestedAt <= VALIDITY_MS;
  requestedAt = null;
  return valid;
}
