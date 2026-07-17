import { describe, expect, it } from "vitest";
import { resolveFocusLatchStep, type FocusLatchStep } from "./terminal-pane-focus-latch";

/**
 * Pins the ordering that caused "terminal stuck at 80x24": the latch must record that the action
 * RAN, not that the effect ran. A pane that mounts before its workspace has focus (or while the
 * app is hidden) must still fire once readiness arrives — burning the latch on the attempt
 * permanently disarms the only resize claim a fresh terminal ever sends.
 */

function run(steps: Array<{ key: string | null; canFire: boolean }>): FocusLatchStep[] {
  const results: FocusLatchStep[] = [];
  let latchedKey: string | null = null;
  for (const step of steps) {
    const result = resolveFocusLatchStep({ ...step, latchedKey });
    latchedKey = result.latchedKey;
    results.push(result);
  }
  return results;
}

describe("resolveFocusLatchStep", () => {
  it("fires immediately when the pane is focused and ready at mount", () => {
    const [step] = run([{ key: "ws:term-1", canFire: true }]);
    expect(step).toEqual({ latchedKey: "ws:term-1", fire: true });
  });

  it("defers instead of burning the latch when readiness arrives late", () => {
    // The bug: pane focused while the workspace is not (or the app is hidden). The old code
    // latched on the first pass and never fired again.
    const steps = run([
      { key: "ws:term-1", canFire: false }, // mount: pane focused, workspace not focused yet
      { key: "ws:term-1", canFire: true }, // workspace focus / visibility arrives
    ]);
    expect(steps[0]).toEqual({ latchedKey: null, fire: false });
    expect(steps[1]).toEqual({ latchedKey: "ws:term-1", fire: true });
  });

  it("fires exactly once per continuous pane-focus period", () => {
    const steps = run([
      { key: "ws:term-1", canFire: true },
      { key: "ws:term-1", canFire: true }, // unrelated re-render
      { key: "ws:term-1", canFire: false }, // workspace blurs...
      { key: "ws:term-1", canFire: true }, // ...and refocuses: not a new pane-focus period
    ]);
    expect(steps).toEqual([
      { latchedKey: "ws:term-1", fire: true },
      { latchedKey: "ws:term-1", fire: false },
      { latchedKey: "ws:term-1", fire: false },
      { latchedKey: "ws:term-1", fire: false },
    ]);
  });

  it("re-arms when the pane blurs and fires again on refocus", () => {
    const steps = run([
      { key: "ws:term-1", canFire: true },
      { key: null, canFire: true }, // pane blurred / terminal gone
      { key: "ws:term-1", canFire: true },
    ]);
    expect(steps).toEqual([
      { latchedKey: "ws:term-1", fire: true },
      { latchedKey: null, fire: false },
      { latchedKey: "ws:term-1", fire: true },
    ]);
  });

  it("fires for a different terminal in the same pane", () => {
    const steps = run([
      { key: "ws:term-1", canFire: true },
      { key: "ws:term-2", canFire: true },
    ]);
    expect(steps).toEqual([
      { latchedKey: "ws:term-1", fire: true },
      { latchedKey: "ws:term-2", fire: true },
    ]);
  });

  it("stays deferred across repeated not-ready passes, then fires once", () => {
    const steps = run([
      { key: "ws:term-1", canFire: false },
      { key: "ws:term-1", canFire: false },
      { key: "ws:term-1", canFire: true },
      { key: "ws:term-1", canFire: true },
    ]);
    expect(steps).toEqual([
      { latchedKey: null, fire: false },
      { latchedKey: null, fire: false },
      { latchedKey: "ws:term-1", fire: true },
      { latchedKey: "ws:term-1", fire: false },
    ]);
  });
});
