import { expect, test } from "vitest";
import { isProviderBusyTurnError, isRecoveredBusyTurnFailure } from "./provider-busy-error.js";
import { summarizeACPRequestError } from "./providers/acp-agent.js";

// The real MiniMax Code answer captured from daemon.log when a prompt reached a
// session whose previous turn had never been released on the provider side.
const MINIMAX_STUCK_TURN = {
  code: -32603,
  message:
    "Internal error: MiniMax Code Runtime failed: Session already has an active Turn. " +
    "Use queue send to deliver the message after it.",
};

test("classifies a provider still holding a previous turn as a busy turn", () => {
  expect(isProviderBusyTurnError(summarizeACPRequestError(MINIMAX_STUCK_TURN))).toBe(true);
});

test("matches the busy-turn message case-insensitively", () => {
  expect(
    isProviderBusyTurnError({ code: "-32603", message: "session already has an active turn" }),
  ).toBe(true);
});

test("does not treat unrelated internal errors as a busy turn", () => {
  expect(isProviderBusyTurnError({ code: "-32603", message: "Internal error: unknown" })).toBe(
    false,
  );
  expect(isProviderBusyTurnError({ code: "-32602", message: "Invalid params" })).toBe(false);
});

test("requires the internal-error code so ordinary provider prose is not recovered", () => {
  expect(isProviderBusyTurnError({ message: "Session already has an active turn." })).toBe(false);
  expect(
    isProviderBusyTurnError({ code: "-32602", message: "Session already has an active turn." }),
  ).toBe(false);
});

test("tolerates missing and malformed error summaries", () => {
  expect(isProviderBusyTurnError(undefined)).toBe(false);
  expect(isProviderBusyTurnError(null)).toBe(false);
  expect(isProviderBusyTurnError({})).toBe(false);
  expect(isProviderBusyTurnError({ code: "-32603" })).toBe(false);
});

// Terminal turn_failed events carry their text on `error`, not `message`; the
// event-level guard must map the fields itself or the recovery never fires.
test("classifies a terminal turn_failed event that names a provider-owned turn", () => {
  expect(
    isRecoveredBusyTurnFailure({
      type: "turn_failed",
      error: "Session already has an active Turn.",
      code: "-32603",
    }),
  ).toBe(true);
  expect(isRecoveredBusyTurnFailure({ type: "turn_failed", error: "boom" })).toBe(false);
  expect(
    isRecoveredBusyTurnFailure({
      type: "turn_completed",
      error: "already has an active turn",
      code: "-32603",
    }),
  ).toBe(false);
});
