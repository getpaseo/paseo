import type { HubRelationshipRetryPolicy } from "./relationship-controller.js";

const INITIAL_DELAY_MS = 500;
const MAX_BASE_DELAY_MS = 30_000;
const MIN_JITTER_FACTOR = 0.75;
const JITTER_RANGE = 0.5;

export class BoundedExponentialHubRetryPolicy implements HubRelationshipRetryPolicy {
  constructor(private readonly random: () => number = Math.random) {}

  delay(attempt: number): number {
    const base = Math.min(MAX_BASE_DELAY_MS, INITIAL_DELAY_MS * 2 ** attempt);
    const jitter = MIN_JITTER_FACTOR + this.random() * JITTER_RANGE;
    return Math.max(1, Math.round(base * jitter));
  }
}
