import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { URI } from "vscode-uri";
import { LspHost } from "./host.js";

const APP_ROOT = resolve(import.meta.dirname, "../../../../app");
const SESSIONS_ROUTE = resolve(APP_ROOT, "src/app/sessions.tsx");
const TYPESCRIPT_LANGUAGE_SERVER = resolve(
  import.meta.dirname,
  "../../../../../node_modules/.bin/typescript-language-server",
);

const logger = pino({ level: "silent" });

function createHost(overrides: Record<string, string> = {}): LspHost {
  return new LspHost({
    logger,
    commandOverrides: { typescript: TYPESCRIPT_LANGUAGE_SERVER, ...overrides },
  });
}

describe("LspHost", () => {
  let host: LspHost | null = null;

  afterEach(async () => {
    await host?.dispose();
    host = null;
  });

  it("reports an unsupported language instead of starting a server", async () => {
    host = createHost();
    const outcome = await host.definition({
      rootPath: APP_ROOT,
      filePath: resolve(APP_ROOT, "README.md"),
      text: "# hi",
      position: { line: 0, character: 2 },
    });
    expect(outcome).toEqual({ status: "unsupported-language" });
  });

  it("reports a missing binary as a state, not an error", async () => {
    host = createHost({ typescript: "/nonexistent/typescript-language-server" });
    const outcome = await host.definition({
      rootPath: APP_ROOT,
      filePath: SESSIONS_ROUTE,
      text: readFileSync(SESSIONS_ROUTE, "utf8"),
      position: { line: 1, character: 12 },
    });
    expect(outcome).toEqual({
      status: "server-not-installed",
      serverId: "typescript",
      command: "/nonexistent/typescript-language-server",
    });
  });

  it("reuses one server process across requests for the same root", async () => {
    host = createHost();
    const text = readFileSync(SESSIONS_ROUTE, "utf8");

    const first = await host.definition({
      rootPath: APP_ROOT,
      filePath: SESSIONS_ROUTE,
      text,
      position: { line: 1, character: 12 },
    });
    const startedAt = Date.now();
    const second = await host.definition({
      rootPath: APP_ROOT,
      filePath: SESSIONS_ROUTE,
      text,
      position: { line: 0, character: 12 },
    });
    const secondDurationMs = Date.now() - startedAt;

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status !== "ok" || second.status !== "ok") {
      return;
    }
    expect(URI.parse(first.links[0]!.targetUri).fsPath).toBe(
      resolve(APP_ROOT, "src/screens/sessions-screen.tsx"),
    );
    expect(URI.parse(second.links[0]!.targetUri).fsPath).toBe(
      resolve(APP_ROOT, "src/components/host-route-bootstrap-boundary.tsx"),
    );
    // A cold start pays the project load; a pooled hit must not.
    expect(secondDurationMs).toBeLessThan(3_000);
  }, 120_000);
});
