import { describe, expect, test } from "vitest";

import { splitMultiSelectAnswer } from "./question-card-answer.js";

describe("splitMultiSelectAnswer", () => {
  const labels = ["Delete both", "Delete both, fix code", "Email the user"];

  test("splits checked labels in click order", () => {
    expect(splitMultiSelectAnswer("Email the user, Delete both", labels)).toEqual({
      selected: ["Email the user", "Delete both"],
      custom: null,
    });
  });

  test("keeps a label that contains a comma as one selection", () => {
    expect(splitMultiSelectAnswer("Delete both, fix code, Email the user", labels)).toEqual({
      selected: ["Delete both, fix code", "Email the user"],
      custom: null,
    });
  });

  test("returns trailing text as the typed answer", () => {
    expect(splitMultiSelectAnswer("Delete both, Also check the logs", labels)).toEqual({
      selected: ["Delete both"],
      custom: "Also check the logs",
    });
    expect(splitMultiSelectAnswer("Only typed text", labels)).toEqual({
      selected: [],
      custom: "Only typed text",
    });
  });
});
