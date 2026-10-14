import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { replaceAppBundle } from "./install-local-app.mjs";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "darwin")("iCloud local app mirror", () => {
  async function fixture() {
    const { source, target } = await createFixture();
    const root = path.dirname(path.dirname(source));
    const env = {
      ...process.env,
      PASEO_LOCAL_MIRROR_HOME: path.join(root, "state"),
      PASEO_LOCAL_MIRROR_FOLDER: path.join(root, "cloud"),
      PASEO_LOCAL_MIRROR_TARGET: target,
    };
    await mkdir(path.join(source, "Contents", "MacOS"), { recursive: true });
    await mkdir(path.join(source, "Contents", "Resources"));
    await rename(
      path.join(source, "version"),
      path.join(source, "Contents", "Resources", "version"),
    );
    await symlink("version", path.join(source, "Contents", "Resources", "current"));
    await writeFile(
      path.join(source, "Contents", "Info.plist"),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>sh.paseo.desktop.local</string><key>CFBundleExecutable</key><string>Paseo</string></dict></plist>`,
    );
    execFileSync("/bin/cp", ["/usr/bin/true", path.join(source, "Contents", "MacOS", "Paseo")]);
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", source]);
    const script = path.resolve("scripts/paseo-local-icloud.command");
    const run = (...args) => spawnSync("/bin/zsh", [script, ...args], { env, encoding: "utf8" });
    return { source, target, env, run };
  }

  it("publishes and installs a verified bundle without a repository on the receiving Mac", async () => {
    const { source, target, env, run } = await fixture();
    expect(run("publish", source).status).toBe(0);
    const published = (
      await readFile(path.join(env.PASEO_LOCAL_MIRROR_FOLDER, "latest.sha256"), "utf8")
    ).trim();
    expect(published).toMatch(/^[a-f0-9]{64}$/);
    expect(run("run").status).toBe(0);
    expect(await readFile(path.join(target, "Contents", "Resources", "version"), "utf8")).toBe(
      "new",
    );
    expect(
      (await readFile(path.join(env.PASEO_LOCAL_MIRROR_HOME, "installed.sha256"), "utf8")).trim(),
    ).toBe(published);
    expect(run("run").stdout).toContain("Already installed");
    expect(await readlink(path.join(target, "Contents", "Resources", "current"))).toBe("version");
  });

  it("keeps the current app when an archive is incomplete, then retries successfully", async () => {
    const { source, target, env, run } = await fixture();
    expect(run("publish", source).status).toBe(0);
    const digest = (
      await readFile(path.join(env.PASEO_LOCAL_MIRROR_FOLDER, "latest.sha256"), "utf8")
    ).trim();
    const archive = path.join(env.PASEO_LOCAL_MIRROR_FOLDER, `${digest}.zip`);
    const complete = await readFile(archive);
    await writeFile(archive, complete.subarray(0, 20));
    expect(run("run").status).toBe(1);
    expect(await readFile(path.join(target, "version"), "utf8")).toBe("old");
    await writeFile(archive, complete);
    expect(run("run").status).toBe(0);
    expect(await readFile(path.join(target, "Contents", "Resources", "version"), "utf8")).toBe(
      "new",
    );
  });

  it("defers replacement while the app is running", async () => {
    const { source, target, run } = await fixture();
    expect(run("publish", source).status).toBe(0);
    const process = spawn("/bin/zsh", [
      "-c",
      'exec -a "$1/Contents/MacOS/Paseo" /bin/sleep 30',
      "mirror-probe",
      target,
    ]);
    try {
      await new Promise((resolve) => process.once("spawn", resolve));
      expect(run("run").stdout).toContain("update deferred");
      expect(await readFile(path.join(target, "version"), "utf8")).toBe("old");
    } finally {
      process.kill();
      await new Promise((resolve) => process.once("exit", resolve));
    }
    expect(run("run").status).toBe(0);
  });

  it("publishes changed builds from the installed app and skips unchanged builds", async () => {
    const { source, env, run } = await fixture();
    expect(run("publish", source).status).toBe(0);
    const manifest = path.join(env.PASEO_LOCAL_MIRROR_FOLDER, "latest.sha256");
    const first = await readFile(manifest, "utf8");
    await writeFile(
      path.join(env.PASEO_LOCAL_MIRROR_HOME, "publisher-folder"),
      env.PASEO_LOCAL_MIRROR_FOLDER,
    );
    expect(run("publish-if-enabled", source).stdout).toContain("Already published");
    await writeFile(path.join(source, "Contents", "Resources", "version"), "second build");
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", source]);
    expect(run("publish-if-enabled", source).status).toBe(0);
    expect(await readFile(manifest, "utf8")).not.toBe(first);
  });

  it("waits for a missing archive and rejects malformed manifests without changing the app", async () => {
    const { source, target, env, run } = await fixture();
    expect(run("publish", source).status).toBe(0);
    const manifest = path.join(env.PASEO_LOCAL_MIRROR_FOLDER, "latest.sha256");
    const digest = (await readFile(manifest, "utf8")).trim();
    await rm(path.join(env.PASEO_LOCAL_MIRROR_FOLDER, `${digest}.zip`));
    expect(run("run").stdout).toContain("Waiting for the archive");
    await writeFile(manifest, "../../other-file");
    expect(run("run").status).toBe(1);
    expect(await readFile(path.join(target, "version"), "utf8")).toBe("old");
  });

  it("rejects an invalid signature even when the archive checksum matches", async () => {
    const { source, target, env, run } = await fixture();
    expect(run("publish", source).status).toBe(0);
    await writeFile(path.join(source, "Contents", "Resources", "version"), "tampered");
    const archive = path.join(env.PASEO_LOCAL_MIRROR_FOLDER, "tampered.zip");
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", source, archive]);
    const digest = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    await rename(archive, path.join(env.PASEO_LOCAL_MIRROR_FOLDER, `${digest}.zip`));
    await writeFile(path.join(env.PASEO_LOCAL_MIRROR_FOLDER, "latest.sha256"), digest);
    expect(run("run").status).toBe(1);
    expect(await readFile(path.join(target, "version"), "utf8")).toBe("old");
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-local-install-"));
  tempDirs.push(root);
  const source = path.join(root, "build", "Paseo.app");
  const target = path.join(root, "Applications", "Paseo Local.app");
  await mkdir(source, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(path.join(source, "version"), "new");
  await writeFile(path.join(target, "version"), "old");
  return { source, target };
}

describe("local desktop app installation", () => {
  it("replaces the installed bundle", async () => {
    const { source, target } = await createFixture();
    await mkdir(path.join(source, "Versions", "A"), { recursive: true });
    await symlink("A", path.join(source, "Versions", "Current"));

    await replaceAppBundle({ source, target });

    expect(await readFile(path.join(target, "version"), "utf8")).toBe("new");
    expect(await readlink(path.join(target, "Versions", "Current"))).toBe("A");
  });

  it("restores the installed bundle when activation fails", async () => {
    const { source, target } = await createFixture();
    let renameCount = 0;

    await expect(
      replaceAppBundle({
        source,
        target,
        rename: async (...args) => {
          renameCount += 1;
          if (renameCount === 2) throw new Error("activation failed");
          await rename(...args);
        },
      }),
    ).rejects.toThrow("activation failed");

    expect(await readFile(path.join(target, "version"), "utf8")).toBe("old");
  });
});
