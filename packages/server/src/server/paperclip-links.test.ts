import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPaperclipLinks } from "./paperclip-links.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function homeWithBoard(board: unknown): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "pandaos-paperclip-"));
  homes.push(home);
  await mkdir(path.join(home, ".config", "paperclip-paseo"), { recursive: true });
  await writeFile(
    path.join(home, ".config", "paperclip-paseo", "board.json"),
    JSON.stringify(board),
  );
  return home;
}

describe("readPaperclipLinks", () => {
  it("returns the board address and its companies' prefixes, never the token", async () => {
    const home = await homeWithBoard({ apiBase: "http://127.0.0.1:3110/", token: "board-secret" });
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer board-secret");
      return new Response(
        JSON.stringify([
          { name: "Vizion", issuePrefix: "VIZ" },
          { name: "Vizion Marketing", issuePrefix: "VIZA" },
          { name: "broken", issuePrefix: "no good" },
        ]),
      );
    });

    const links = await readPaperclipLinks({ home, fetchImpl: fetchImpl as never, now: 1 });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:3110/api/companies",
      expect.anything(),
    );
    expect(links).toEqual({ webBaseUrl: "http://127.0.0.1:3110", prefixes: ["VIZ", "VIZA"] });
    expect(JSON.stringify(links)).not.toContain("board-secret");
  });

  it("is null without a board", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "pandaos-paperclip-none-"));
    homes.push(home);
    await expect(readPaperclipLinks({ home, now: 2 })).resolves.toBeNull();
  });
});
