import compareVersions from "semver/functions/compare.js";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { execCommand } from "../../../utils/spawn.js";
import { findExecutable } from "../../../executable-resolution/executable-resolution.js";

const LockfileSchema = z.object({
  lockfileVersion: z.number().min(2),
  packages: z.record(
    z.string(),
    z.object({
      version: z.string().optional(),
      resolved: z.string().optional(),
      integrity: z.string().optional(),
    }),
  ),
});

const NPM_SOURCE_PATTERN =
  /^(?<name>(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@(?<spec>[^:@/\\]+))?$/;

export function isNpmSource(source: string): boolean {
  return source.startsWith("npm:") || NPM_SOURCE_PATTERN.test(source);
}

function parseNpmSource(source: string): { packageName: string; requestedSpec: string } {
  const spec = source.replace(/^npm:/, "");
  const match = NPM_SOURCE_PATTERN.exec(spec);
  if (!match?.groups) {
    throw new Error(
      `Invalid npm plugin source: ${source}. Use npm:package or npm:@scope/package@version, tag, or range.`,
    );
  }
  const requestedSpec = match.groups.spec ?? "latest";
  if (!requestedSpec.trim() || requestedSpec !== requestedSpec.trim()) {
    throw new Error("An npm version, tag, or range must be non-empty without surrounding spaces");
  }
  return { packageName: match.groups.name, requestedSpec };
}

export async function acquireNpm(source: string, installRoot: string, target?: NpmArtifact) {
  const { packageName, requestedSpec } = parseNpmSource(source);
  await writeFile(
    path.join(installRoot, "package.json"),
    JSON.stringify({
      name: "paseo-plugin-installation",
      version: "1.0.0",
      private: true,
      dependencies: { [packageName]: target?.resolved ?? requestedSpec },
    }),
  );
  const npm = await requireNpm();
  await execCommand(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
      "--package-lock=true",
      "--lockfile-version=3",
      "--include=prod",
      "--omit=dev",
      "--global=false",
      "--workspaces=false",
    ],
    { cwd: installRoot, timeout: 120_000, maxBuffer: 1024 * 1024 },
  );
  const installed = await readNpmArtifact(installRoot, packageName);
  if (
    target &&
    (installed.version !== target.version ||
      installed.integrity !== target.integrity ||
      installed.resolved !== target.resolved)
  ) {
    throw new Error(`npm artifact changed since review for ${packageName}`);
  }
  return { packageName, ...installed };
}

export interface NpmArtifact {
  version: string;
  resolved: string;
  integrity: string;
}

export async function readNpmArtifact(
  installRoot: string,
  packageName: string,
): Promise<NpmArtifact> {
  const lock = LockfileSchema.parse(
    JSON.parse(await readFile(path.join(installRoot, "package-lock.json"), "utf8")),
  );
  const artifact = lock.packages[`node_modules/${packageName}`];
  if (!artifact?.version || !artifact.resolved || !artifact.integrity)
    throw new Error(`Missing npm artifact for ${packageName}`);
  const installed = z
    .object({ name: z.string(), version: z.string() })
    .parse(
      JSON.parse(
        await readFile(path.join(installRoot, "node_modules", packageName, "package.json"), "utf8"),
      ),
    );
  const root = z
    .object({ dependencies: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile(path.join(installRoot, "package.json"), "utf8")));
  if (
    Object.keys(root.dependencies).length !== 1 ||
    !(packageName in root.dependencies) ||
    installed.name !== packageName ||
    installed.version !== artifact.version
  ) {
    throw new Error(
      `Installed npm package does not match its acquisition artifacts: ${packageName}`,
    );
  }
  return { version: artifact.version, resolved: artifact.resolved, integrity: artifact.integrity };
}

export async function resolveNpm(
  packageName: string,
  selector: string,
  cwd: string,
): Promise<NpmArtifact> {
  // Validate selectors using the same grammar as installation; never interpret an update as another source.
  parseNpmSource(`npm:${packageName}@${selector}`);
  const { stdout } = await execCommand(
    await requireNpm(),
    ["view", `${packageName}@${selector}`, "version", "dist", "--json"],
    { cwd, timeout: 120_000, maxBuffer: 1024 * 1024 },
  );
  const schema = z.object({
    version: z.string(),
    dist: z.object({ tarball: z.string().url(), integrity: z.string().min(1) }),
  });
  const raw: unknown = JSON.parse(stdout);
  const entries = z.array(schema).parse(Array.isArray(raw) ? raw : [raw]);
  const latest = entries.sort((a, b) => compareVersions(b.version, a.version))[0];
  if (!latest) throw new Error(`No npm version matches ${packageName}@${selector}`);
  return {
    version: latest.version,
    resolved: latest.dist.tarball,
    integrity: latest.dist.integrity,
  };
}

async function requireNpm(): Promise<string> {
  const npm = await findExecutable("npm");
  if (!npm)
    throw new Error(
      "npm is required on the daemon host to acquire or check npm plugins. Install Node.js with npm and make npm available on the daemon's PATH.",
    );
  return npm;
}
