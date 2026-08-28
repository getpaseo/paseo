/**
 * Fleet presenter seam: `useLiveActivity` targets this surface and never imports a native module
 * directly. Metro picks `presenter.native.ts` on iOS/Android and this no-op base everywhere else
 * (web resolves `presenter.web.ts`, an identical stub, first).
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
