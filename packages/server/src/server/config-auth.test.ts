import { mkdir, mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";
import { isBearerTokenValid } from "./auth.js";
import { FLEET_CONTROL_PORTFOLIO_AGENT_ID } from "@getpaseo/protocol/fleet-control";

const roots: string[] = [];
const CONFIG_PASSWORD_HASH = "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW";

async function createPaseoHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-config-auth-"));
  roots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  await writeFile(path.join(paseoHome, "config.json"), JSON.stringify(config, null, 2));
  return paseoHome;
}

async function createFleetLedger(paseoHome: string, contents?: string): Promise<string> {
  const ledgerPath = path.join(paseoHome, "private", "fleet.md");
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(
    ledgerPath,
    contents ??
      `| 64e89b9a-ff01-4cd8-b3f8-202bd276bc1d | Target | owner | active | now | evidence | <!--["fleet-control.v1","64e89b9a-ff01-4cd8-b3f8-202bd276bc1d","open",0,null,"${FLEET_CONTROL_PORTFOLIO_AGENT_ID}"]-->remaining |\n`,
  );
  return ledgerPath;
}

describe("daemon auth config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("loads optional auth password hash from config.json", async () => {
    const paseoHome = await createPaseoHome({
      version: 1,
      daemon: {
        auth: { password: CONFIG_PASSWORD_HASH },
      },
    });

    const config = loadConfig(paseoHome, { env: {} });

    expect(config.auth?.password).toBe(CONFIG_PASSWORD_HASH);
    expect(isBearerTokenValid({ password: config.auth?.password, token: "correct-password" })).toBe(
      true,
    );
  });

  test("lets PASEO_PASSWORD override config.json auth password hash", async () => {
    const paseoHome = await createPaseoHome({
      version: 1,
      daemon: {
        auth: { password: CONFIG_PASSWORD_HASH },
      },
    });

    const config = loadConfig(paseoHome, {
      env: { PASEO_PASSWORD: "from-env" },
    });

    expect(config.auth?.password).not.toBe(CONFIG_PASSWORD_HASH);
    expect(config.auth?.password).toMatch(/^\$2[aby]\$12\$/);
    expect(isBearerTokenValid({ password: config.auth?.password, token: "from-env" })).toBe(true);
  });

  test("loads Fleet ledger and Deck credential only from trusted server environment", async () => {
    const paseoHome = await createPaseoHome({ version: 1 });
    const ledgerPath = await createFleetLedger(paseoHome);
    const env = {
      PASEO_FLEET_COMMITMENT_LEDGER_PATH: ledgerPath,
      PASEO_FIRSTMATE_DECK_CREDENTIAL: "deck-secret",
    };
    const config = loadConfig(paseoHome, {
      env,
    });

    expect(config.fleetCommitmentControls).toEqual({ ledgerPath: await realpath(ledgerPath) });
    expect(config.auth?.firstmateDeckCredential).toMatch(/^\$2[aby]\$12\$/);
    expect(
      isBearerTokenValid({
        password: config.auth?.firstmateDeckCredential,
        token: "deck-secret",
      }),
    ).toBe(true);
    expect(env).toEqual({});
    expect(config.configReload?.env.PASEO_FIRSTMATE_DECK_CREDENTIAL).toBeUndefined();
    expect(config.configReload?.env.PASEO_FLEET_COMMITMENT_LEDGER_PATH).toBeUndefined();
  });

  test("rejects partial Fleet server configuration", async () => {
    const paseoHome = await createPaseoHome({ version: 1 });
    expect(() =>
      loadConfig(paseoHome, {
        env: { PASEO_FLEET_COMMITMENT_LEDGER_PATH: path.join(paseoHome, "fleet.md") },
      }),
    ).toThrow("Fleet controls require both ledger path and Deck credential");
  });

  test("removes Fleet secrets from process.env after one startup ingestion", async () => {
    const paseoHome = await createPaseoHome({ version: 1 });
    const ledgerPath = await createFleetLedger(paseoHome);
    process.env.PASEO_FLEET_COMMITMENT_LEDGER_PATH = ledgerPath;
    process.env.PASEO_FIRSTMATE_DECK_CREDENTIAL = "process-only-secret";
    try {
      const config = loadConfig(paseoHome);
      expect(config.fleetCommitmentControls?.ledgerPath).toBe(await realpath(ledgerPath));
      expect(process.env.PASEO_FLEET_COMMITMENT_LEDGER_PATH).toBeUndefined();
      expect(process.env.PASEO_FIRSTMATE_DECK_CREDENTIAL).toBeUndefined();
    } finally {
      delete process.env.PASEO_FLEET_COMMITMENT_LEDGER_PATH;
      delete process.env.PASEO_FIRSTMATE_DECK_CREDENTIAL;
    }
  });

  test("rejects equal owner and Deck credentials at configuration ingestion", async () => {
    const paseoHome = await createPaseoHome({ version: 1 });
    const ledgerPath = await createFleetLedger(paseoHome);
    expect(() =>
      loadConfig(paseoHome, {
        env: {
          PASEO_PASSWORD: "same-secret",
          PASEO_FIRSTMATE_DECK_CREDENTIAL: "same-secret",
          PASEO_FLEET_COMMITMENT_LEDGER_PATH: ledgerPath,
        },
      }),
    ).toThrow("Owner and Deck credentials must differ");
  });

  test.each([
    ["missing", "missing.md", undefined],
    ["non-regular", "directory", "directory"],
    ["malformed", "malformed.md", "not a Fleet ledger\n"],
  ])("rejects a %s startup Fleet ledger", async (_case, name, contents) => {
    const paseoHome = await createPaseoHome({ version: 1 });
    const ledgerPath = path.join(paseoHome, name);
    if (contents === "directory") await mkdir(ledgerPath);
    else if (contents !== undefined) await writeFile(ledgerPath, contents);
    expect(() =>
      loadConfig(paseoHome, {
        env: {
          PASEO_FIRSTMATE_DECK_CREDENTIAL: "deck-secret",
          PASEO_FLEET_COMMITMENT_LEDGER_PATH: ledgerPath,
        },
      }),
    ).toThrow(/Fleet commitment ledger/u);
  });
});
