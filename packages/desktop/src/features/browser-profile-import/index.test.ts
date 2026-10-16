import { afterEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CometProfileImporter, decodeCometCookie, type CookieRow } from "./index.js";
import { serializeBrowserProfileOperation } from "../browser-profile.js";

const row: CookieRow = {
  host_key: ".example.com",
  name: "session",
  value: "",
  encrypted: "",
  path: "/account",
  expires_utc: 0,
  is_secure: 1,
  is_httponly: 1,
  samesite: 1,
  has_expires: 0,
  top_frame_site_key: "",
};
function encrypt(host: string, value: string) {
  const cipher = createCipheriv(
    "aes-128-cbc",
    pbkdf2Sync("test", "saltysalt", 1003, 16, "sha1"),
    Buffer.alloc(16, 32),
  );
  return Buffer.concat([
    Buffer.from("v10"),
    cipher.update(Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)])),
    cipher.final(),
  ]).toString("hex");
}
const directories: string[] = [];
afterEach(() => {
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});
function fixture(version = "24") {
  const root = mkdtempSync(path.join(tmpdir(), "comet-test-"));
  directories.push(root);
  mkdirSync(path.join(root, "Default"));
  execFileSync("/usr/bin/sqlite3", [
    path.join(root, "Default/Cookies"),
    `CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES('version','${version}'); CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,path TEXT,expires_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,has_expires INTEGER,top_frame_site_key TEXT); INSERT INTO cookies VALUES('.example.com','session','',X'${encrypt(row.host_key, "secret")}','/account',0,1,1,1,0,'');`,
  ]);
  return root;
}
describe("Comet cookies", () => {
  it("decrypts and preserves identity, security, host scope and session expiry", () => {
    expect(
      decodeCometCookie({ ...row, encrypted: encrypt(row.host_key, "secret") }, "test"),
    ).toEqual({
      url: "https://example.com/account",
      name: "session",
      value: "secret",
      domain: ".example.com",
      path: "/account",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    });
    expect(
      decodeCometCookie({ ...row, host_key: "example.com", value: "host" }, "test"),
    ).not.toHaveProperty("domain");
  });
  it("preserves persistent expiry and insecure host-only cookie attributes", () => {
    const cookie = decodeCometCookie(
      {
        ...row,
        host_key: "example.com",
        value: "value",
        has_expires: 1,
        expires_utc: (2_000_000_000 + 11644473600) * 1_000_000,
        is_secure: 0,
        is_httponly: 0,
        samesite: -1,
      },
      "test",
    );
    expect(cookie).toEqual({
      url: "http://example.com/account",
      name: "session",
      value: "value",
      path: "/account",
      secure: false,
      httpOnly: false,
      sameSite: "unspecified",
      expirationDate: 2_000_000_000,
    });
  });
  it("rejects corrupted domain integrity and unsupported encryption", () => {
    expect(() =>
      decodeCometCookie({ ...row, encrypted: encrypt("other.com", "secret") }, "test"),
    ).toThrow("invalid domain digest");
    expect(() =>
      decodeCometCookie({ ...row, encrypted: Buffer.from("v20bad").toString("hex") }, "test"),
    ).toThrow("unsupported encryption");
  });
  it("skips expired and partitioned cookies", () => {
    expect(decodeCometCookie({ ...row, has_expires: 1 }, "test")).toBeNull();
    expect(
      decodeCometCookie({ ...row, top_frame_site_key: "https://other.com" }, "test"),
    ).toBeNull();
  });
  it.runIf(process.platform === "darwin")(
    "snapshots synthetic SQLite, imports repeatedly and flushes without editing source",
    async () => {
      const root = fixture();
      const importer = new CometProfileImporter(root, async () => "test");
      const original = readFileSync(path.join(root, "Default/Cookies"));
      const [profile] = await importer.listProfiles();
      expect(profile.name).toBe("Default");
      expect(profile.id).not.toContain(root);
      const cookies = { set: vi.fn(async () => {}), flushStore: vi.fn(async () => {}) };
      expect(await importer.importProfile(profile.id, cookies)).toEqual({
        status: "complete",
        imported: 1,
        skipped: 0,
        failed: 0,
      });
      await importer.importProfile(profile.id, cookies);
      expect(cookies.set).toHaveBeenCalledTimes(2);
      expect(cookies.flushStore).toHaveBeenCalledTimes(2);
      expect(cookies.set.mock.calls[0]).toEqual(cookies.set.mock.calls[1]);
      expect(readFileSync(path.join(root, "Default/Cookies"))).toEqual(original);
    },
  );
  it.runIf(process.platform === "darwin")(
    "backs up committed WAL data while the source browser database stays open",
    async () => {
      const root = fixture();
      const writer = spawn("/usr/bin/sqlite3", [path.join(root, "Default/Cookies")]);
      try {
        const ready = new Promise<void>((resolve, reject) => {
          writer.once("error", reject);
          writer.stdout.on("data", (data) => {
            if (data.toString().includes("READY")) resolve();
          });
          writer.once("exit", () => reject(new Error("SQLite writer exited before READY")));
        });
        writer.stdin.write(
          "PRAGMA journal_mode=WAL;\nINSERT INTO cookies SELECT host_key,'second',value,encrypted_value,path,expires_utc,is_secure,is_httponly,samesite,has_expires,top_frame_site_key FROM cookies;\nSELECT 'READY';\n",
        );
        await ready;
        const importer = new CometProfileImporter(root, async () => "test");
        const [profile] = await importer.listProfiles();
        expect(
          await importer.importProfile(profile.id, {
            set: async () => {},
            flushStore: async () => {},
          }),
        ).toEqual({ status: "complete", imported: 2, skipped: 0, failed: 0 });
      } finally {
        writer.stdin.end(".quit\n");
        await new Promise<void>((resolve) => writer.once("exit", () => resolve()));
      }
    },
  );
  it.runIf(process.platform === "darwin")(
    "rejects missing databases and arbitrary profile identifiers before writing",
    async () => {
      const root = fixture();
      const importer = new CometProfileImporter(root, async () => "test");
      const [profile] = await importer.listProfiles();
      const cookies = { set: vi.fn(async () => {}), flushStore: vi.fn(async () => {}) };
      await expect(importer.importProfile("/arbitrary/path", cookies)).rejects.toThrow(
        "Profil Comet indisponible",
      );
      rmSync(path.join(root, "Default/Cookies"));
      await expect(importer.importProfile(profile.id, cookies)).rejects.toThrow(
        "Impossible de lire",
      );
      expect(cookies.set).not.toHaveBeenCalled();
    },
  );
  it.runIf(process.platform === "darwin")(
    "refuses unknown schemas and keychain failure before writing",
    async () => {
      const cookies = { set: vi.fn(async () => {}), flushStore: vi.fn(async () => {}) };
      const unknown = new CometProfileImporter(fixture("25"), async () => "test");
      const [profile] = await unknown.listProfiles();
      await expect(unknown.importProfile(profile.id, cookies)).rejects.toThrow(
        "pas prise en charge",
      );
      const denied = new CometProfileImporter(fixture(), async () => {
        throw new Error("denied");
      });
      const [other] = await denied.listProfiles();
      await expect(denied.importProfile(other.id, cookies)).rejects.toThrow("Trousseau");
      expect(cookies.set).not.toHaveBeenCalled();
    },
  );
  it.runIf(process.platform === "darwin")("reports partial writes and flush failures", async () => {
    const importer = new CometProfileImporter(fixture(), async () => "test");
    const [profile] = await importer.listProfiles();
    const result = await importer.importProfile(profile.id, {
      set: async () => {
        throw new Error("write failed");
      },
      flushStore: async () => {},
    });
    expect(result).toMatchObject({ status: "partial", imported: 0, failed: 1 });
    expect(
      await importer.importProfile(profile.id, {
        set: async () => {},
        flushStore: async () => {
          throw new Error("flush failed");
        },
      }),
    ).toMatchObject({ status: "partial", imported: 1 });
  });
  it("serializes profile operations even after failure", async () => {
    const order: string[] = [];
    const first = serializeBrowserProfileOperation(async () => {
      order.push("import");
      throw new Error("failure");
    });
    const second = serializeBrowserProfileOperation(async () => {
      order.push("clear");
    });
    await expect(first).rejects.toThrow("failure");
    await second;
    expect(order).toEqual(["import", "clear"]);
  });
});
