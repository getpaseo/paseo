import { describe, expect, it } from "vitest";
import type { MermaidRenderRequest } from "../render-model";
import { MermaidRuntimeRequestDriver } from "./request-driver";

function request(revision: number, source: string): MermaidRenderRequest {
  return { revision, source, colorScheme: "dark" };
}

describe("MermaidRuntimeRequestDriver", () => {
  it("tries queued streaming prefixes in order until the runtime renders one", () => {
    const driver = new MermaidRuntimeRequestDriver();
    const first = request(1, "flow");
    const valid = request(2, "flowchart TD\nA --> B\n");
    const transient = request(3, "flowchart TD\nA --> B\nB --");

    expect(driver.update(first)).toBeNull();
    expect(driver.update(valid)).toBeNull();
    expect(driver.update(transient)).toBeNull();
    expect(driver.ready()).toBe(valid);
    expect(driver.settled(valid.revision, true)).toBe(transient);
  });

  it("keeps completed lines but collapses incomplete token revisions before readiness", () => {
    const driver = new MermaidRuntimeRequestDriver();
    const partial = request(1, "flowchart TD\nA --");
    const completed = request(2, "flowchart TD\nA --> B\n");
    const nextPartial = request(3, "flowchart TD\nA --> B\nB --");
    const latestPartial = request(4, "flowchart TD\nA --> B\nB -->");

    driver.update(partial);
    driver.update(completed);
    driver.update(nextPartial);
    driver.update(latestPartial);

    expect(driver.ready()).toBe(completed);
    expect(driver.settled(completed.revision, true)).toBe(latestPartial);
  });

  it("collapses later updates to the newest request after the first render", () => {
    const driver = new MermaidRuntimeRequestDriver();
    const first = request(1, "flowchart TD\nA --> B");
    const second = request(2, "flowchart TD\nA --> B\nB --> C");
    const latest = request(3, "flowchart TD\nA --> B\nB --> D");

    driver.update(first);
    expect(driver.ready()).toBe(first);
    expect(driver.settled(first.revision, true)).toBeNull();
    expect(driver.update(second)).toBe(second);
    expect(driver.update(latest)).toBeNull();
    expect(driver.settled(second.revision, false)).toBe(latest);
  });
});
