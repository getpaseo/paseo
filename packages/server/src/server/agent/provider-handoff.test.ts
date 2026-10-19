import { expect, test } from "vitest";
import { buildProviderHandoff, withProviderHandoff } from "./provider-handoff.js";

test("handoff includes messages and tool evidence without replaying private reasoning", () => {
  const result = buildProviderHandoff([
    { type: "user_message", text: "Fix the build" },
    { type: "reasoning", text: "private reasoning" },
    {
      type: "tool_call",
      callId: "build",
      name: "shell",
      status: "completed",
      error: null,
      detail: { type: "shell", command: "npm test", output: "all tests passed", exitCode: 0 },
    },
    { type: "assistant_message", text: "The build works" },
  ]);
  expect(result.text).toContain("Fix the build");
  expect(result.text).toContain("all tests passed");
  expect(result.text).not.toContain("private reasoning");
  expect(result.omittedItems).toBe(0);
});

test("handoff bounds even an oversized newest item and discloses lost context", () => {
  const result = buildProviderHandoff(
    [
      { type: "user_message", text: "old context" },
      { type: "assistant_message", text: "x".repeat(300_000) + "newest evidence" },
    ],
    16_000,
  );
  expect(result.text.length).toBeLessThan(21_000);
  expect(result.text).toContain("newest evidence");
  expect(result.text).not.toContain("old context");
  expect(result.omittedItems).toBe(2);
});

test("handoff preserves structured image attachments on the new message", () => {
  const image = { type: "image" as const, data: "image-data", mimeType: "image/png" };
  expect(
    withProviderHandoff([image, { type: "text", text: "Inspect this" }], "previous task"),
  ).toEqual([
    { type: "text", text: expect.stringContaining("previous task") },
    image,
    { type: "text", text: "Inspect this" },
  ]);
});
