import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPaseoLaunchAgentPlist,
  PASEO_LAUNCH_AGENT_LABEL,
  PaseoLaunchAgentOwnershipError,
  reconcilePaseoLaunchAgent,
  resolvePaseoLaunchAgentPath,
} from "./launch-agent";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "paseo-launch-agent-"));
  tempRoots.push(root);
  return root;
}

function appResourcesPath(root: string, appName = "Paseo.app"): string {
  return path.join(root, "Applications", appName, "Contents", "Resources");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Paseo LaunchAgent", () => {
  it("owns a generic upstream service file that runs the packaged launcher", () => {
    const home = tempRoot();
    const resourcesPath = appResourcesPath(home);
    const plist = createPaseoLaunchAgentPlist({ home, resourcesPath });

    expect(PASEO_LAUNCH_AGENT_LABEL).toBe("sh.paseo.desktop.daemon");
    expect(resolvePaseoLaunchAgentPath(home)).toBe(
      path.join(home, "Library", "LaunchAgents", "sh.paseo.desktop.daemon.plist"),
    );
    expect(plist).toContain(
      `<string>${path.join(resourcesPath, "bin", "paseo-daemon-launcher")}</string>`,
    );
    expect(plist).toContain("<key>PASEO_DESKTOP_MANAGED</key>");
    expect(plist).toContain(`  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>`);
    expect(plist).not.toContain("<key>KeepAlive</key>\n  <true/>");
  });

  it("leaves an unchanged owned service file in place", () => {
    const home = tempRoot();
    const resourcesPath = appResourcesPath(home);
    const filePath = resolvePaseoLaunchAgentPath(home);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, createPaseoLaunchAgentPlist({ home, resourcesPath }));
    const inode = statSync(filePath).ino;

    expect(reconcilePaseoLaunchAgent({ home, resourcesPath, platform: "darwin" })).toEqual({
      path: filePath,
      changed: false,
    });
    expect(statSync(filePath).ino).toBe(inode);
  });

  it("atomically replaces an outdated owned service file", () => {
    const home = tempRoot();
    const filePath = resolvePaseoLaunchAgentPath(home);
    const oldResourcesPath = appResourcesPath(home, "Paseo Old.app");
    const resourcesPath = appResourcesPath(home);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, createPaseoLaunchAgentPlist({ home, resourcesPath: oldResourcesPath }));
    const oldInode = statSync(filePath).ino;

    expect(reconcilePaseoLaunchAgent({ home, resourcesPath, platform: "darwin" })).toEqual({
      path: filePath,
      changed: true,
    });
    expect(readFileSync(filePath, "utf8")).toBe(
      createPaseoLaunchAgentPlist({ home, resourcesPath }),
    );
    expect(statSync(filePath).ino).not.toBe(oldInode);
    expect(readdirSync(path.dirname(filePath))).toEqual([path.basename(filePath)]);
  });

  it("refuses to overwrite an unmanaged service file with the same label", () => {
    const home = tempRoot();
    const resourcesPath = appResourcesPath(home);
    const filePath = resolvePaseoLaunchAgentPath(home);
    const unmanaged = `<?xml version="1.0"?><plist><dict><key>Label</key><string>${PASEO_LAUNCH_AGENT_LABEL}</string></dict></plist>`;
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, unmanaged);

    let thrown: unknown;
    try {
      reconcilePaseoLaunchAgent({ home, resourcesPath, platform: "darwin" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PaseoLaunchAgentOwnershipError);
    expect(thrown).toMatchObject({
      name: "PaseoLaunchAgentOwnershipError",
      filePath,
      message: `refusing to overwrite unmanaged LaunchAgent at ${filePath}`,
    });
    expect(readFileSync(filePath, "utf8")).toBe(unmanaged);
  });
});
