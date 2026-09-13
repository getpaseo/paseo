import { expect, test, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { registerActions } from "../client/actions";

test("an older host cannot register workflow mutations without persistent server settings", () => {
  const handle = vi.fn();
  const oldHost = { registerSettings: () => undefined, handle, before: vi.fn(), on: vi.fn() };
  expect(() => contribute(oldHost as unknown as PluginServerContext)).toThrow(
    "Update the Paseo host",
  );
  expect(handle).not.toHaveBeenCalled();
});

test("an older app gets an actionable plan contribution capability error", () => {
  expect(() => registerActions({} as Parameters<typeof registerActions>[0])).toThrow(
    "Update the Paseo app",
  );
});
