import { expect, test } from "vitest";
import { shouldNotifyTask } from "./notification-policy";
const preferences = { completed: true, failed: true, waiting: true, whileViewing: false };
const input = {
  reason: "finished" as const,
  preferences,
  away: true,
  native: false,
  visible: true,
  backgroundPush: false,
};
test("each device applies its own attention preferences", () => {
  expect(shouldNotifyTask(input)).toBe(true);
  expect(shouldNotifyTask({ ...input, away: false })).toBe(false);
  expect(
    shouldNotifyTask({
      ...input,
      away: false,
      preferences: { ...preferences, whileViewing: true },
    }),
  ).toBe(true);
  expect(shouldNotifyTask({ ...input, reason: "error" })).toBe(true);
  expect(shouldNotifyTask({ ...input, preferences: { ...preferences, completed: false } })).toBe(
    false,
  );
});
test("Android uses push in the background when configured, avoiding a duplicate local alert", () => {
  expect(shouldNotifyTask({ ...input, native: true, visible: false, backgroundPush: true })).toBe(
    false,
  );
  expect(shouldNotifyTask({ ...input, native: true, visible: true, backgroundPush: true })).toBe(
    true,
  );
  expect(shouldNotifyTask({ ...input, native: true, visible: false })).toBe(true);
});
