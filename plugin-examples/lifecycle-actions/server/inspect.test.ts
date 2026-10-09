import { expect, test } from "vitest";
import { latestOutputText } from "./inspect";

test("matches provider text split across timeline chunks without matching old turns or user prompts", () => {
  const output = latestOutputText([
    { type: "user_message", text: "An older request" },
    { type: "assistant_message", text: "old out of credits" },
    { type: "user_message", text: "The user mentions out of credits" },
    { type: "assistant_message", text: "out", messageId: "reply" },
    { type: "assistant_message", text: " of credits", messageId: "reply" },
  ]);
  expect(output).toBe("out of credits");
  expect(
    latestOutputText([
      { type: "assistant_message", text: "out of credits" },
      { type: "user_message", text: "Try again." },
      { type: "assistant_message", text: "Done" },
    ]),
  ).toBe("Done");
});
