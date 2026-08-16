import { describe, expect, it } from "vitest";
import { AfterPaintPublication, type AfterPaintScheduler } from "./after-paint-publication";

function createManualScheduler(): AfterPaintScheduler & {
  run: () => void;
  scheduledCount: () => number;
} {
  let callbacks: Array<() => void> = [];
  return {
    schedule: (callback) => {
      callbacks.push(callback);
      return () => {
        callbacks = callbacks.filter((candidate) => candidate !== callback);
      };
    },
    run: () => {
      const scheduled = callbacks;
      callbacks = [];
      for (const callback of scheduled) callback();
    },
    scheduledCount: () => callbacks.length,
  };
}

describe("AfterPaintPublication", () => {
  it("publishes the latest staged value once after paint", () => {
    const scheduler = createManualScheduler();
    const published: string[] = [];
    const publication = new AfterPaintPublication(
      (value: string) => published.push(value),
      scheduler,
    );

    publication.stage("a");
    publication.stage("ab");
    publication.stage("abc");

    expect(scheduler.scheduledCount()).toBe(1);
    expect(published).toEqual([]);
    scheduler.run();
    expect(published).toEqual(["abc"]);
  });

  it("flushes synchronously and cancels the scheduled publication", () => {
    const scheduler = createManualScheduler();
    const published: string[] = [];
    const publication = new AfterPaintPublication(
      (value: string) => published.push(value),
      scheduler,
    );

    publication.stage("draft");
    publication.flush();
    scheduler.run();

    expect(published).toEqual(["draft"]);
  });

  it("cancels pending text before a draft is cleared", () => {
    const scheduler = createManualScheduler();
    const published: string[] = [];
    const publication = new AfterPaintPublication(
      (value: string) => published.push(value),
      scheduler,
    );

    publication.stage("sent text");
    publication.cancel();
    scheduler.run();

    expect(published).toEqual([]);
  });
});
