import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type pino from "pino";
import { describe, expect, test, vi } from "vitest";
import { openDatabase } from "../db/open.js";
import { PRIVATE_FILE_MODE } from "../private-files.js";
import { PushTokenStore } from "./token-store.js";

const MODE_MASK = 0o777;
const PERMISSIVE_FILE_MODE = 0o644;

function createLogger(warn: pino.Logger["warn"] = () => undefined): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn,
    error: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

function modeOf(filePath: string): number {
  return statSync(filePath).mode & MODE_MASK;
}

function createStore(
  database: DatabaseSync,
  tokenPath: string,
  logger = createLogger(),
): PushTokenStore {
  return new PushTokenStore({ database, legacyFilePath: tokenPath, logger });
}

describe.skipIf(process.platform === "win32")("PushTokenStore file permissions", () => {
  test("persists push tokens in a private database", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
    const tokenPath = path.join(home, "paseo.db");
    const database = openDatabase(home);
    try {
      const store = createStore(database, path.join(home, "push-tokens.json"));

      store.renewToken("ExponentPushToken[test]");

      expect(modeOf(tokenPath)).toBe(PRIVATE_FILE_MODE);
    } finally {
      database.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("repairs existing push token file permissions when importing", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
    const tokenPath = path.join(home, "push-tokens.json");
    writeFileSync(tokenPath, JSON.stringify({ tokens: ["ExponentPushToken[test]"] }));
    chmodSync(tokenPath, PERMISSIVE_FILE_MODE);
    const database = openDatabase(home);
    try {
      const store = createStore(database, tokenPath);

      expect(store.getActiveTokens()).toEqual(["ExponentPushToken[test]"]);
      expect(modeOf(tokenPath)).toBe(PRIVATE_FILE_MODE);
    } finally {
      database.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("PushTokenStore legacy import", () => {
  test("imports once and records the marker", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
    const tokenPath = path.join(home, "push-tokens.json");
    writeFileSync(
      tokenPath,
      JSON.stringify({
        subscriptions: [
          {
            token: "ExponentPushToken[legacy]",
            expiresAt: "2099-08-12T00:00:00.000Z",
          },
        ],
      }),
    );
    const database = openDatabase(home);
    try {
      const store = createStore(database, tokenPath);
      expect(store.getActiveTokens()).toEqual(["ExponentPushToken[legacy]"]);
      store.revokeToken("ExponentPushToken[legacy]");

      const reloaded = createStore(database, tokenPath);

      expect(reloaded.getActiveTokens()).toEqual([]);
      expect(
        database
          .prepare("SELECT imported_count FROM legacy_imports WHERE store = ?")
          .get("push_tokens"),
      ).toMatchObject({ imported_count: 1 });
    } finally {
      database.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("skips and logs invalid legacy tokens", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
    const tokenPath = path.join(home, "push-tokens.json");
    writeFileSync(tokenPath, JSON.stringify({ tokens: ["ExponentPushToken[valid]", "  ", 42] }));
    const database = openDatabase(home);
    const warn = vi.fn();
    try {
      const store = createStore(database, tokenPath, createLogger(warn));

      expect(store.getActiveTokens()).toEqual(["ExponentPushToken[valid]"]);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(
        database
          .prepare("SELECT skipped_count FROM legacy_imports WHERE store = ?")
          .get("push_tokens"),
      ).toMatchObject({ skipped_count: 2 });
    } finally {
      database.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rolls back the whole legacy import when its marker cannot be written", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
    const tokenPath = path.join(home, "push-tokens.json");
    writeFileSync(tokenPath, JSON.stringify({ tokens: ["ExponentPushToken[legacy]"] }));
    const database = openDatabase(home);
    database.exec(`
      CREATE TRIGGER reject_legacy_import_marker
      BEFORE INSERT ON legacy_imports
      BEGIN
        SELECT RAISE(ABORT, 'marker rejected');
      END;
    `);
    try {
      expect(() => createStore(database, tokenPath)).toThrow("Failed to import legacy push tokens");
      expect(database.prepare("SELECT count(*) AS count FROM push_tokens").get()).toMatchObject({
        count: 0,
      });
      expect(database.prepare("SELECT count(*) AS count FROM legacy_imports").get()).toMatchObject({
        count: 0,
      });
    } finally {
      database.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("PushTokenStore persistence", () => {
  test("does not apply a revocation until the updated subscriptions are durable", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
    const database = openDatabase(home);
    try {
      const store = createStore(database, path.join(home, "push-tokens.json"));
      store.renewToken("ExponentPushToken[test]");
      database.exec(`
        CREATE TRIGGER reject_push_token_delete
        BEFORE DELETE ON push_tokens
        BEGIN
          SELECT RAISE(ABORT, 'delete rejected');
        END;
      `);

      expect(() => store.revokeToken("ExponentPushToken[test]")).toThrow("delete rejected");
      expect(store.getActiveTokens()).toEqual(["ExponentPushToken[test]"]);

      database.exec("DROP TRIGGER reject_push_token_delete");
      store.revokeToken("ExponentPushToken[test]");
      expect(store.getActiveTokens()).toEqual([]);
    } finally {
      database.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
