import { expect, it } from "vitest";
import { renderError, toCommandError } from "./index.js";

it("preserves the message of an Error with an RPC code in JSON output", () => {
  const error = Object.assign(new Error("Plugin requires Paseo >=0.8.0. Your daemon is 0.7.2."), {
    code: "handler_error",
    requestId: "request-1",
  });
  expect(JSON.parse(renderError(toCommandError(error), { format: "json" }))).toEqual({
    error: {
      code: "handler_error",
      requestId: "request-1",
      message: "Plugin requires Paseo >=0.8.0. Your daemon is 0.7.2.",
    },
  });
});
