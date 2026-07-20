import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { deriveMessageHistory } from "./use-message-history";

const userMessage = (text: string, id = text): StreamItem =>
  ({ kind: "user_message", id, text, timestamp: new Date(0) }) as StreamItem;
const assistantMessage = (text: string): StreamItem =>
  ({ kind: "assistant_message", id: text, text, timestamp: new Date(0) }) as StreamItem;
const thought = (): StreamItem =>
  ({ kind: "thought", text: "thinking", timestamp: new Date(0) }) as StreamItem;

describe("deriveMessageHistory", () => {
  it("keeps only user messages, in stream order (oldest-first)", () => {
    const items: StreamItem[] = [
      userMessage("first"),
      assistantMessage("a1"),
      userMessage("second"),
    ];
    expect(deriveMessageHistory(items)).toEqual(["first", "second"]);
  });

  it("ignores non-user items such as assistant messages and thoughts", () => {
    const items: StreamItem[] = [thought(), userMessage("only"), assistantMessage("reply")];
    expect(deriveMessageHistory(items)).toEqual(["only"]);
  });

  it("ignores empty and whitespace-only user messages", () => {
    const items: StreamItem[] = [userMessage("   "), userMessage("real"), userMessage("")];
    expect(deriveMessageHistory(items)).toEqual(["real"]);
  });

  it("trims surrounding whitespace before storing", () => {
    expect(deriveMessageHistory([userMessage("  hi  ")])).toEqual(["hi"]);
  });

  it("caps to the most recent N entries", () => {
    const items: StreamItem[] = ["1", "2", "3", "4"].map((t) => userMessage(t));
    expect(deriveMessageHistory(items, 2)).toEqual(["3", "4"]);
  });

  it("returns an empty list when there are no user messages", () => {
    expect(deriveMessageHistory([assistantMessage("a"), thought()])).toEqual([]);
  });
});
