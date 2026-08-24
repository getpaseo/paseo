import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLIENT_FORGE_LOGIC_MODULES } from "./index";
import { CLIENT_FORGE_VIEW_MODULES } from "./view";

/**
 * Adding a forge is "create forges/<id>.ts (logic) + forges/<id>.view.tsx (view)
 * + register one line in each registry". This test removes the only failure mode
 * of the explicit registries — forgetting a line — without resorting to
 * bundler-specific auto-discovery that Metro, Vite, and tsgo would each need to
 * understand differently. The logic/view split keeps logic consumers (URL
 * builders, merge-capability, native checks, and the Node e2e harness) free of
 * the client rendering stack.
 */
const forgesDir = path.dirname(new URL(import.meta.url).pathname);
const dirEntries = readdirSync(forgesDir);

const logicModuleIds = dirEntries
  .filter((file) => /^[a-z0-9-]+\.ts$/.test(file) && file !== "index.ts" && file !== "view.ts")
  .map((file) => file.replace(/\.ts$/, ""))
  .sort();

const viewModuleIds = dirEntries
  .filter((file) => /^[a-z0-9-]+\.view\.tsx$/.test(file))
  .map((file) => file.replace(/\.view\.tsx$/, ""))
  .sort();

describe("CLIENT_FORGE_LOGIC_MODULES completeness", () => {
  it("registers every forge logic module file in the directory", () => {
    const registeredIds = CLIENT_FORGE_LOGIC_MODULES.map((module) => module.id).sort();
    expect(registeredIds).toEqual(logicModuleIds);
  });

  it("has no duplicate forge ids", () => {
    const ids = CLIENT_FORGE_LOGIC_MODULES.map((module) => module.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("CLIENT_FORGE_VIEW_MODULES completeness", () => {
  it("registers every forge view module file in the directory", () => {
    const registeredIds = CLIENT_FORGE_VIEW_MODULES.map((module) => module.id).sort();
    expect(registeredIds).toEqual(viewModuleIds);
  });

  it("has no duplicate forge ids", () => {
    const ids = CLIENT_FORGE_VIEW_MODULES.map((module) => module.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("forge logic and view registries stay paired", () => {
  it("has a view module for every logic module and vice versa", () => {
    const logicIds = CLIENT_FORGE_LOGIC_MODULES.map((module) => module.id).sort();
    const viewIds = CLIENT_FORGE_VIEW_MODULES.map((module) => module.id).sort();
    expect(logicIds).toEqual(viewIds);
  });
});
