import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { PluginSecretStore } from "./secrets.js";
import { PluginSettingsStore } from "./settings/index.js";

const directories: string[] = [];

async function createStore() {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-secrets-"));
  directories.push(directory);
  return { directory, store: new PluginSecretStore(directory) };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("PluginSecretStore", () => {
  it("round-trips a value and reports absence as null", async () => {
    const { store } = await createStore();

    expect(await store.get("api-token")).toBeNull();
    expect(await store.has("api-token")).toBe(false);

    await store.set("api-token", "secret-value");

    expect(await store.get("api-token")).toBe("secret-value");
    expect(await store.has("api-token")).toBe(true);
  });

  it("writes owner-only so another account on the host cannot read the token", async () => {
    const { directory, store } = await createStore();

    await store.set("api-token", "secret-value");

    const mode = (await stat(path.join(directory, "_secrets.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("lists key names without exposing values", async () => {
    const { store } = await createStore();

    await store.set("b-token", "second");
    await store.set("a-token", "first");

    expect(await store.keys()).toEqual(["a-token", "b-token"]);
  });

  it("removes a key", async () => {
    const { store } = await createStore();

    await store.set("api-token", "secret-value");
    await store.delete("api-token");

    expect(await store.get("api-token")).toBeNull();
    expect(await store.keys()).toEqual([]);
  });

  it("keeps concurrent writes to different keys", async () => {
    const { store } = await createStore();

    await Promise.all([store.set("first", "1"), store.set("second", "2"), store.set("third", "3")]);

    expect(await store.keys()).toEqual(["first", "second", "third"]);
  });

  it("rejects a key that is not a plain identifier", async () => {
    const { store } = await createStore();

    await expect(store.set("../escape", "x")).rejects.toThrow("Invalid plugin secret key");
    await expect(store.get("Token")).rejects.toThrow("Invalid plugin secret key");
  });

  it("treats an unreadable or corrupt file as empty instead of throwing", async () => {
    const { directory, store } = await createStore();
    await writeFile(path.join(directory, "_secrets.json"), "{not json", "utf8");

    expect(await store.get("api-token")).toBeNull();

    await store.set("api-token", "recovered");
    expect(await store.get("api-token")).toBe("recovered");
  });

  it("leaves no temporary file behind", async () => {
    const { directory, store } = await createStore();

    await store.set("api-token", "secret-value");

    const raw = await readFile(path.join(directory, "_secrets.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ "api-token": "secret-value" });
  });

  it("cannot be overwritten through a settings document that shares the plugin directory", async () => {
    const { directory, store } = await createStore();
    await store.set("api-token", "secret-value");
    const settings = new PluginSettingsStore(directory, () => {}).register(
      defineSettings({
        id: "secrets",
        scope: "host",
        version: 1,
        schema: z.object({ label: z.string().default("") }),
      }),
    );

    expect(await settings.read.handle()).toMatchObject({ status: "ready", revision: "missing" });
    await settings.write.handle({ revision: "missing", values: { label: "client write" } });

    expect(await store.get("api-token")).toBe("secret-value");
  });

  it("moves secrets written under the legacy file name once", async () => {
    const { directory, store } = await createStore();
    const legacy = path.join(directory, "secrets.json");
    await writeFile(legacy, JSON.stringify({ "api-token": "legacy-value" }), "utf8");

    expect(await store.get("api-token")).toBe("legacy-value");
    await expect(access(legacy)).rejects.toThrow();
    const moved = path.join(directory, "_secrets.json");
    expect((await stat(moved)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(moved, "utf8"))).toEqual({ "api-token": "legacy-value" });
  });

  it("leaves a settings document named secrets where it is", async () => {
    const { directory, store } = await createStore();
    const document = JSON.stringify({ version: 1, values: { label: "not a secret" } });
    await writeFile(path.join(directory, "secrets.json"), document, "utf8");

    expect(await store.keys()).toEqual([]);
    await store.set("api-token", "secret-value");

    expect(await readFile(path.join(directory, "secrets.json"), "utf8")).toBe(document);
    expect(await store.get("api-token")).toBe("secret-value");
  });
});
