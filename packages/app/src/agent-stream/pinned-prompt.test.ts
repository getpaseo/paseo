import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { resolvePinnedPrompt } from "./pinned-prompt";

const item = (id: string, kind: "user_message" | "assistant_message", text: string) =>
  ({ id, kind, text }) as StreamItem;

describe("resolvePinnedPrompt", () => {
  const items = [
    item("first", "user_message", "Première demande"),
    item("first-answer", "assistant_message", "Réponse longue"),
    item("second", "user_message", "Deuxième demande"),
    item("second-answer", "assistant_message", "Autre réponse"),
  ];

  it("pins only the prompt for the response under the reading line", () => {
    expect(resolvePinnedPrompt(items, "first")).toBeNull();
    expect(resolvePinnedPrompt(items, "first-answer")?.id).toBe("first");
    expect(resolvePinnedPrompt(items, "second")).toBeNull();
    expect(resolvePinnedPrompt(items, "second-answer")?.id).toBe("second");
    expect(resolvePinnedPrompt(items, null)).toBeNull();
  });
});
