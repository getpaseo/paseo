import { describe, expect, test } from "vitest";
import { getPaseoBrowserIdForWebContents, registerPaseoBrowserWebContents } from "./index.js";

class FakeRegisteredWebContents {
  public readonly backgroundThrottlingCalls: boolean[] = [];
  private destroyedListener: (() => void) | null = null;
  private destroyed = false;

  public constructor(public readonly id: number) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public setBackgroundThrottling(allowed: boolean): void {
    this.backgroundThrottlingCalls.push(allowed);
  }

  public once(event: "destroyed", listener: () => void): void {
    expect(event).toBe("destroyed");
    this.destroyedListener = listener;
  }

  public destroy(): void {
    this.destroyed = true;
    this.destroyedListener?.();
  }
}

describe("registerPaseoBrowserWebContents", () => {
  test("disables guest background throttling once when the webview is registered", () => {
    const contents = new FakeRegisteredWebContents(9001);

    registerPaseoBrowserWebContents(contents, "browser-throttle");

    expect(contents.backgroundThrottlingCalls).toEqual([false]);
    expect(getPaseoBrowserIdForWebContents(contents)).toBe("browser-throttle");

    contents.destroy();

    expect(getPaseoBrowserIdForWebContents(contents)).toBeNull();
    expect(contents.backgroundThrottlingCalls).toEqual([false]);
  });
});
