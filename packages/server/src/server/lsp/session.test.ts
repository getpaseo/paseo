import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { URI } from "vscode-uri";
import { descriptorForFile, languageIdForFile, resolveLanguageServer } from "./language-servers.js";
import { LspSession } from "./session.js";

const APP_ROOT = resolve(import.meta.dirname, "../../../../app");
const SESSIONS_ROUTE = resolve(APP_ROOT, "src/app/sessions.tsx");
// Pin the binary the workspace installs so the test proves the round trip on every machine,
// instead of skipping wherever the user has not installed a server globally.
const TYPESCRIPT_LANGUAGE_SERVER = resolve(
  import.meta.dirname,
  "../../../../../node_modules/.bin/typescript-language-server",
);

const logger = pino({ level: "silent" });

describe("descriptorForFile", () => {
  it("maps each extension to the language id the server expects", () => {
    const descriptor = descriptorForFile("a.tsx");
    expect(descriptor?.id).toBe("typescript");
    expect(languageIdForFile(descriptor!, "a.tsx")).toBe("typescriptreact");
    expect(languageIdForFile(descriptor!, "a.ts")).toBe("typescript");
    expect(languageIdForFile(descriptor!, "a.mjs")).toBe("javascript");
  });

  it("claims nothing for extensions no configured server handles", () => {
    expect(descriptorForFile("notes.md")).toBeNull();
    expect(descriptorForFile("Makefile")).toBeNull();
  });
});

describe("resolveLanguageServer", () => {
  it("prefers a configured command over the descriptor default", async () => {
    const descriptor = descriptorForFile("a.ts")!;
    const seen: string[] = [];
    const resolved = await resolveLanguageServer(descriptor, "/opt/custom-tsls", async (name) => {
      seen.push(name);
      return "/opt/custom-tsls";
    });
    expect(seen).toEqual(["/opt/custom-tsls"]);
    expect(resolved?.executablePath).toBe("/opt/custom-tsls");
  });

  it("reports an absent binary as null rather than throwing", async () => {
    const descriptor = descriptorForFile("a.ts")!;
    expect(await resolveLanguageServer(descriptor, undefined, async () => null)).toBeNull();
  });
});

describe("LspSession against a real language server", () => {
  let session: LspSession | null = null;

  afterEach(async () => {
    await session?.dispose();
    session = null;
  });

  it("resolves an aliased import to its declaration", async () => {
    const descriptor = descriptorForFile(SESSIONS_ROUTE)!;
    const server = await resolveLanguageServer(descriptor, TYPESCRIPT_LANGUAGE_SERVER);
    expect(server).not.toBeNull();

    session = new LspSession({ server: server!, rootPath: APP_ROOT, logger });

    // `import { SessionsScreen } from "@/screens/sessions-screen"` — on the symbol.
    const links = await session.definition({
      filePath: SESSIONS_ROUTE,
      text: readFileSync(SESSIONS_ROUTE, "utf8"),
      position: { line: 1, character: 12 },
    });

    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(URI.parse(link.targetUri).fsPath).toBe(
      resolve(APP_ROOT, "src/screens/sessions-screen.tsx"),
    );
    // The server reports the symbol's own range, so the app never computes symbol bounds.
    expect(link.originSelectionRange).toEqual({
      start: { line: 1, character: 9 },
      end: { line: 1, character: 23 },
    });
    expect(session.negotiatedPositionEncoding).toBe("utf-16");
  }, 90_000);

  it("returns no links for a position on punctuation", async () => {
    const descriptor = descriptorForFile(SESSIONS_ROUTE)!;
    const server = await resolveLanguageServer(descriptor, TYPESCRIPT_LANGUAGE_SERVER);
    session = new LspSession({ server: server!, rootPath: APP_ROOT, logger });
    const links = await session.definition({
      filePath: SESSIONS_ROUTE,
      text: readFileSync(SESSIONS_ROUTE, "utf8"),
      position: { line: 2, character: 0 },
    });
    expect(links).toEqual([]);
  }, 90_000);
});
