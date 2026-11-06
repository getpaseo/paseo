import { expect, test } from "vitest";
import { backgroundWorkText } from "./presentation";

test("shows descriptions and commands once, with useful fallbacks", () => {
  expect(
    backgroundWorkText({ description: "Watch build", command: "tail -f build.log" }, "Monitor"),
  ).toEqual({ title: "Watch build", command: "tail -f build.log" });
  expect(backgroundWorkText({ description: null, command: "sleep 10" }, "Shell")).toEqual({
    title: "sleep 10",
    command: null,
  });
  expect(backgroundWorkText({ description: "sleep 10", command: "sleep 10" }, "Shell")).toEqual({
    title: "sleep 10",
    command: null,
  });
  expect(backgroundWorkText({ description: null }, "Shell")).toEqual({
    title: "Shell",
    command: null,
  });
});
