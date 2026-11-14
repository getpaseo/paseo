import { describe, expect, test } from "vitest";
import { AgentPermissionResponseSchema } from "./messages.js";
import { QuestionAnswersSchema } from "./question-answers.js";

describe("structured question answers", () => {
  test("round-trips independent option identities and text through permission metadata", () => {
    const questionAnswers = {
      Colors: { selectedOptionIds: ["red", "blue", "red-duplicate"], otherText: "Red, Blue" },
      Comment: { selectedOptionIds: [], otherText: "Red" },
    };
    const response = AgentPermissionResponseSchema.parse(
      JSON.parse(
        JSON.stringify({
          behavior: "allow",
          updatedInput: { questionAnswers },
        }),
      ),
    );
    if (response.behavior !== "allow") throw new Error("Expected allow response");
    expect(QuestionAnswersSchema.parse(response.updatedInput?.questionAnswers)).toEqual(
      questionAnswers,
    );
  });

  test("keeps accepting permission responses without structured answers", () => {
    const response = { behavior: "allow", updatedInput: { answers: { Colors: "Red, Blue" } } };
    expect(AgentPermissionResponseSchema.parse(response)).toEqual(response);
    expect(AgentPermissionResponseSchema.parse({ behavior: "deny" })).toEqual({ behavior: "deny" });
  });
});
