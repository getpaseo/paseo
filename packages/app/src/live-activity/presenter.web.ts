/**
 * Fleet presenter seam: `useLiveActivity` targets this surface and never imports a native module
 * directly. Live Activities are iOS-only; the web bundle always gets this no-op stub.
 */

import type { FleetSnapshot } from "./fleet-snapshot";

export interface FleetReceipt {
  durationMs: number;
  finishedTitle: string;
}

export function supported(): boolean {
  return false;
}

export async function start(_snapshot: FleetSnapshot): Promise<void> {}

export async function update(_snapshot: FleetSnapshot): Promise<void> {}

export async function end(_receipt: FleetReceipt): Promise<void> {}
