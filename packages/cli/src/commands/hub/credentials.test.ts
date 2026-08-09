import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { DEFAULT_HUB_ORIGIN, resolveHubCredential, resolveHubOrigin } from "./authority.js";
import { PrivateHubCredentialStore, type HubCredentialStore } from "./credentials.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Hub CLI credentials", () => {
  it("stores multiple normalized origins privately and selects the latest login", () => {
    const home = temporaryHome();
    const store = new PrivateHubCredentialStore({ PASEO_HOME: home });

    store.save({ origin: "https://first.example.com", credential: "first-secret" });
    store.save({ origin: "https://second.example.com:443", credential: "second-secret" });

    assert.deepEqual(store.get("https://first.example.com"), {
      origin: "https://first.example.com",
      credential: "first-secret",
    });
    assert.deepEqual(store.active(), {
      origin: "https://second.example.com",
      credential: "second-secret",
    });
    if (process.platform !== "win32") {
      assert.equal(statSync(home).mode & 0o777, 0o700);
      assert.equal(statSync(path.join(home, "hub-credentials.json")).mode & 0o777, 0o600);
    }
    assert.deepEqual(
      readdirSync(home).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  });

  it("logs out only the active human credential and preserves other origins", () => {
    const store = new PrivateHubCredentialStore({ PASEO_HOME: temporaryHome() });
    store.save({ origin: "https://first.example.com", credential: "first-secret" });
    store.save({ origin: "https://second.example.com", credential: "second-secret" });

    assert.equal(store.logoutActive()?.origin, "https://second.example.com");
    assert.equal(store.active(), null);
    assert.equal(store.get("https://second.example.com"), null);
    assert.equal(store.get("https://first.example.com")?.credential, "first-secret");
  });

  it("rejects malformed storage without exposing persisted secrets", () => {
    const home = temporaryHome();
    const secret = "stored-secret-must-not-leak";
    writeFileSync(path.join(home, "hub-credentials.json"), `{"credential":"${secret}"}`);
    chmodSync(path.join(home, "hub-credentials.json"), 0o600);

    assert.throws(
      () => new PrivateHubCredentialStore({ PASEO_HOME: home }).active(),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(secret), false);
        assert.equal(JSON.stringify(error).includes(secret), false);
        return true;
      },
    );
  });

  it("repairs permissive persisted file modes before returning credentials", () => {
    if (process.platform === "win32") return;
    const home = temporaryHome();
    const store = new PrivateHubCredentialStore({ PASEO_HOME: home });
    store.save({ origin: "https://hub.test", credential: "stored-secret" });
    const credentialPath = path.join(home, "hub-credentials.json");
    chmodSync(credentialPath, 0o644);

    assert.equal(store.active()?.credential, "stored-secret");
    assert.equal(statSync(credentialPath).mode & 0o777, 0o600);
  });

  it("resolves origin from explicit, environment, active login, then hosted default", () => {
    const store = new PrivateHubCredentialStore({ PASEO_HOME: temporaryHome() });
    store.save({ origin: "https://stored.example.com", credential: "stored-secret" });

    assert.equal(
      resolveHubOrigin({
        options: { origin: "https://explicit.example.com" },
        env: { PASEO_HUB_URL: "https://env.example.com" },
        credentials: store,
      }),
      "https://explicit.example.com",
    );
    assert.equal(
      resolveHubOrigin({
        options: {},
        env: { PASEO_HUB_URL: "https://env.example.com" },
        credentials: store,
      }),
      "https://env.example.com",
    );
    assert.equal(
      resolveHubOrigin({ options: {}, env: {}, credentials: store }),
      "https://stored.example.com",
    );
    assert.equal(
      resolveHubOrigin({
        options: {},
        env: {},
        credentials: new PrivateHubCredentialStore({ PASEO_HOME: temporaryHome() }),
      }),
      DEFAULT_HUB_ORIGIN,
    );
  });

  it("resolves credential from explicit, environment, then exact-origin stored login", () => {
    const store = new PrivateHubCredentialStore({ PASEO_HOME: temporaryHome() });
    store.save({ origin: "https://stored.example.com", credential: "stored-secret" });

    assert.equal(
      resolveHubCredential({
        origin: "https://stored.example.com",
        options: { origin: "https://stored.example.com", apiKey: "explicit-secret" },
        env: { PASEO_HUB_API_KEY: "env-secret" },
        credentials: store,
      }),
      "explicit-secret",
    );
    assert.equal(
      resolveHubCredential({
        origin: "https://stored.example.com",
        options: { origin: "https://stored.example.com" },
        env: { PASEO_HUB_API_KEY: "env-secret" },
        credentials: store,
      }),
      "env-secret",
    );
    assert.equal(
      resolveHubCredential({
        origin: "https://stored.example.com",
        options: { origin: "https://stored.example.com" },
        env: {},
        credentials: store,
      }),
      "stored-secret",
    );
  });

  it("never applies a stored credential to a different origin", () => {
    const store = new PrivateHubCredentialStore({ PASEO_HOME: temporaryHome() });
    store.save({ origin: "https://stored.example.com", credential: "stored-secret" });

    assert.throws(
      () =>
        resolveHubCredential({
          origin: "https://different.example.com",
          options: { origin: "https://different.example.com" },
          env: {},
          credentials: store,
        }),
      { code: "HUB_API_KEY_REQUIRED" },
    );
  });

  it("does not access stored login when explicit origin and API key are complete", () => {
    const unavailableStore: HubCredentialStore = {
      active: () => {
        throw new Error("must not read active login");
      },
      get: () => {
        throw new Error("must not read stored credential");
      },
      save: () => {},
      logoutActive: () => null,
    };

    assert.equal(
      resolveHubCredential({
        origin: "https://hub.test",
        options: { origin: "https://hub.test", apiKey: "explicit-secret" },
        env: {},
        credentials: unavailableStore,
      }),
      "explicit-secret",
    );
  });
});

function temporaryHome(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "paseo-hub-credentials-"));
  temporaryDirectories.push(directory);
  return directory;
}
