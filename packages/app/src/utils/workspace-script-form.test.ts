import { expect, test } from "vitest";
import { validateWorkspaceScriptDraft } from "./workspace-script-form.js";

test("allows an automatic port and validates the shared service fields", () => {
  expect(
    validateWorkspaceScriptDraft({ name: "dev", command: "npm run dev", port: "" }),
  ).toBeNull();
  expect(validateWorkspaceScriptDraft({ name: "", command: "npm run dev", port: "" })).toBe(
    "name_required",
  );
  expect(validateWorkspaceScriptDraft({ name: "dev", command: "  ", port: "" })).toBe(
    "command_required",
  );
  expect(validateWorkspaceScriptDraft({ name: "dev", command: "vite", port: "65536" })).toBe(
    "port_invalid",
  );
  expect(
    validateWorkspaceScriptDraft({ name: "dev", command: "vite", port: "3000", collides: true }),
  ).toBe("name_collision");
});
