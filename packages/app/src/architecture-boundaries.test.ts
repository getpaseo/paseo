import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));
const UI_ROOTS = [
  "app",
  "agent-skills",
  "agent-stream",
  "command-center",
  "components",
  "composer",
  "contexts",
  "desktop",
  "file-pane",
  "git",
  "hooks",
  "panels",
  "plugins",
  "projects",
  "provider-usage",
  "screens",
  "subagents",
  "workspace",
  "workspace-recovery",
  "workspace-tabs",
] as const;
const SESSION_STORE_OWNER_FILES = new Set(["plugins/client-state/source.ts"]);

function productionSources(root: string): string[] {
  const sources: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      sources.push(...productionSources(path));
      continue;
    }
    if (![".ts", ".tsx"].includes(extname(entry.name))) continue;
    if (/\.(test|spec)\.[^.]+$/.test(entry.name)) continue;
    sources.push(path);
  }
  return sources;
}

function importedModules(source: string): string[] {
  return Array.from(
    source.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g),
    (match) => match[1] ?? "",
  );
}

function importsSessionStoreValue(source: string): boolean {
  return Array.from(source.matchAll(/import\s+(?!type\b)[\s\S]*?from\s+["']([^"']+)["']/g)).some(
    (match) => match[1] === "@/stores/session-store",
  );
}

function importsAgentStoreProjection(path: string): boolean {
  return importedModules(readFileSync(path, "utf8")).some((module) =>
    module.includes("runtime/directory-sync/internal/agent-store"),
  );
}

describe("app architecture boundaries", () => {
  it("keeps UI leaves behind semantic session queries and commands", () => {
    const violations: string[] = [];
    for (const root of UI_ROOTS) {
      for (const path of productionSources(join(SOURCE_ROOT, root))) {
        const source = readFileSync(path, "utf8");
        const sourcePath = relative(SOURCE_ROOT, path);
        const modules = importedModules(source);
        const reasons = [
          ...(importsSessionStoreValue(source) && !SESSION_STORE_OWNER_FILES.has(sourcePath)
            ? ["imports session-store"]
            : []),
          ...(modules.some(
            (module) =>
              module.includes("runtime/replica-cache") ||
              module.includes("runtime/client-replica/internal/cache"),
          )
            ? ["imports replica cache internals"]
            : []),
          ...(source.includes("useSessionStore") && !SESSION_STORE_OWNER_FILES.has(sourcePath)
            ? ["uses useSessionStore"]
            : []),
          ...(source.includes("getHostRuntimeStore") ? ["uses getHostRuntimeStore"] : []),
        ];
        for (const reason of reasons) {
          violations.push(`${sourcePath}: ${reason}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps cache internals private to the client-replica entry point", () => {
    const publicEntry = join(SOURCE_ROOT, "runtime/client-replica/index.ts");
    const violations: string[] = [];
    for (const path of productionSources(SOURCE_ROOT)) {
      if (path === publicEntry || path.includes("/runtime/client-replica/internal/cache/"))
        continue;
      const modules = importedModules(readFileSync(path, "utf8"));
      if (
        modules.some(
          (module) =>
            module.includes("client-replica/internal/cache") ||
            module.includes("runtime/replica-cache"),
        )
      ) {
        violations.push(relative(SOURCE_ROOT, path));
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the session hook entry point query-only", () => {
    const source = readFileSync(join(SOURCE_ROOT, "stores/session-store-hooks/index.ts"), "utf8");
    expect(source).not.toMatch(/export\s+(?:const|function)\s+read[A-Z]/);
    expect(source).not.toMatch(/export\s+type\s+\{[^}]*SessionState/s);
    expect(source).not.toMatch(/Commands\s*[={]/);
    expect(source).not.toContain("useSessionStore.getState");
    expect(importedModules(source)).not.toContain("@getpaseo/client/internal/daemon-client");
  });

  it("keeps agent store projection private to the agent directory owner", () => {
    const owner = join(SOURCE_ROOT, "runtime/directory-sync/agent-replica.ts");
    const violations = productionSources(SOURCE_ROOT)
      .filter((path) => path !== owner && !path.includes("/runtime/directory-sync/internal/"))
      .filter(importsAgentStoreProjection)
      .map((path) => relative(SOURCE_ROOT, path));
    expect(violations).toEqual([]);
    expect(readFileSync(join(SOURCE_ROOT, "utils/agent-directory-sync.ts"), "utf8")).not.toContain(
      "useSessionStore",
    );
  });
});
