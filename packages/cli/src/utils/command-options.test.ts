import { Command } from "commander";
import { expect, test } from "vitest";
import { addDaemonHostOption } from "./command-options.js";

test("preserves an empty daemon host option from Commander", () => {
  const command = addDaemonHostOption(new Command());
  command.parse(["node", "paseo", "--host="]);

  expect(command.opts()).toEqual({ host: "" });
});
