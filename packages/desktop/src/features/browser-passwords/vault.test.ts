import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PasswordCrypto, PasswordVault, PasswordVaultFileError } from "./vault";

function createFakeCrypto(available = true): PasswordCrypto {
  return {
    isAvailable: () => available,
    encrypt: (plainText) => Buffer.from(`enc:${plainText}`, "utf8"),
    decrypt: (cipherText) => {
      const plainText = cipherText.toString("utf8");
      if (!plainText.startsWith("enc:")) throw new Error("bad cipher text");
      return plainText.slice(4);
    },
  };
}

describe("PasswordVault", () => {
  let dir: string;
  let filePath: string;
  let clock: number;

  function createVault(crypto = createFakeCrypto()): PasswordVault {
    return new PasswordVault({ filePath, crypto, now: () => clock });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "paseo-password-vault-"));
    filePath = join(dir, "browser-passwords.json");
    clock = 1000;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores passwords encrypted with owner-only permissions and reads them back", () => {
    const vault = createVault();
    expect(vault.save("https://example.com", "ada", "s3cret")).toBe(true);

    const raw = readFileSync(filePath, "utf8");
    expect(raw).not.toContain("s3cret");
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      entries: {
        "https://example.com": [
          {
            username: "ada",
            password: createFakeCrypto().encrypt("s3cret").toString("base64"),
            updatedAt: 1000,
            lastUsedAt: 1000,
          },
        ],
      },
      never: [],
    });

    expect(createVault().lookup("https://example.com")).toEqual([
      { username: "ada", password: "s3cret" },
    ]);
  });

  it("upserts by username and returns the most recently used login first", () => {
    const vault = createVault();
    vault.save("https://example.com", "ada", "one");
    clock = 2000;
    vault.save("https://example.com", "bob", "two");
    clock = 3000;
    vault.save("https://example.com", "ada", "three");

    expect(vault.list()).toEqual([
      { origin: "https://example.com", username: "ada" },
      { origin: "https://example.com", username: "bob" },
    ]);
    expect(vault.lookup("https://example.com")).toEqual([
      { username: "ada", password: "three" },
      { username: "bob", password: "two" },
    ]);
  });

  it("touches lastUsedAt of the returned login on lookup", () => {
    const vault = createVault();
    vault.save("https://example.com", "ada", "one");
    clock = 5000;
    vault.lookup("https://example.com");

    const stored = JSON.parse(readFileSync(filePath, "utf8")).entries["https://example.com"][0];
    expect(stored).toMatchObject({ username: "ada", updatedAt: 1000, lastUsedAt: 5000 });
  });

  it("matches origins exactly", () => {
    const vault = createVault();
    vault.save("https://example.com", "ada", "one");
    expect(vault.lookup("http://example.com")).toEqual([]);
    expect(vault.lookup("https://sub.example.com")).toEqual([]);
  });

  it("reports whether a stored password is unchanged", () => {
    const vault = createVault();
    vault.save("https://example.com", "ada", "one");
    expect(vault.has("https://example.com", "ada", "one")).toBe(true);
    expect(vault.has("https://example.com", "ada", "two")).toBe(false);
    expect(vault.has("https://example.com", "bob", "one")).toBe(false);
  });

  it("removes logins and never-listed origins persist", () => {
    const vault = createVault();
    vault.save("https://example.com", "ada", "one");
    vault.save("https://example.com", "bob", "two");
    vault.remove("https://example.com", "ada");
    vault.setNever("https://blocked.test");

    const reopened = createVault();
    expect(reopened.list()).toEqual([{ origin: "https://example.com", username: "bob" }]);
    expect(reopened.isNever("https://blocked.test")).toBe(true);
    expect(reopened.isNever("https://example.com")).toBe(false);

    reopened.remove("https://example.com", "bob");
    expect(JSON.parse(readFileSync(filePath, "utf8")).entries).toEqual({});
  });

  it("never writes anything when encryption is unavailable", () => {
    const vault = createVault(createFakeCrypto(false));
    expect(vault.save("https://example.com", "ada", "one")).toBe(false);
    expect(vault.lookup("https://example.com")).toEqual([]);
    expect(vault.has("https://example.com", "ada", "one")).toBe(false);
    expect(() => statSync(filePath)).toThrow();
  });

  it("refuses to continue on a corrupt file instead of overwriting it", () => {
    writeFileSync(filePath, "{not json");
    expect(() => createVault().save("https://example.com", "ada", "one")).toThrow(
      PasswordVaultFileError,
    );
    expect(readFileSync(filePath, "utf8")).toBe("{not json");
  });
});
