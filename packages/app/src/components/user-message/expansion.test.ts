import { describe, expect, it } from "vitest";
import { createUserMessageExpansion } from "./expansion";

describe("user message expansion", () => {
  it("toggles one message and notifies only that message", () => {
    const expansion = createUserMessageExpansion();
    const notified: string[] = [];
    expansion.subscribe("first", () => notified.push("first"));
    expansion.subscribe("second", () => notified.push("second"));

    expansion.toggle("first");
    expect(expansion.isExpanded("first")).toBe(true);
    expect(expansion.isExpanded("second")).toBe(false);

    expansion.toggle("first");
    expect(expansion.isExpanded("first")).toBe(false);
    expect(notified).toEqual(["first", "first"]);
  });

  it("keeps a message's choice after its subscribers leave, as a remounting row does", () => {
    const expansion = createUserMessageExpansion();
    const unsubscribe = expansion.subscribe("first", () => undefined);
    expansion.toggle("first");
    unsubscribe();

    const notified: string[] = [];
    expansion.subscribe("first", () => notified.push("first"));
    expect(expansion.isExpanded("first")).toBe(true);
    expect(notified).toEqual([]);
  });
});
