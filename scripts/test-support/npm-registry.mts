import { execCommand } from "../../packages/server/src/utils/spawn.js";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

interface FixturePackage {
  name: string;
  version: string;
  files: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  tags?: string[];
}

/** A registry serving real npm-packed artifacts, including integrity and host auth configuration. */
export async function startNpmRegistry(packages: FixturePackage[]) {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-npm-registry-"));
  const artifacts = new Map<string, Buffer>();
  const manifests = new Map<
    string,
    { name: string; versions: Record<string, unknown>; "dist-tags": Record<string, string> }
  >();
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = decodeURIComponent(request.url ?? "");
    requests.push(url);
    if (request.headers.authorization !== "Bearer fixture-token") {
      response.writeHead(401).end(JSON.stringify({ error: "Registry token required" }));
      return;
    }
    const artifact = artifacts.get(url);
    if (artifact) {
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(artifact);
      return;
    }
    const manifest = manifests.get(url.slice(1));
    response.writeHead(manifest ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(manifest ?? { error: "Package not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected registry port");
  const url = `http://127.0.0.1:${address.port}`;
  const userconfig = path.join(root, "npmrc");
  await writeFile(
    userconfig,
    `registry=${url}/\n//127.0.0.1:${address.port}/:_authToken=fixture-token\ncache=${root}/cache\n`,
  );
  try {
    for (const [index, pkg] of packages.entries()) {
      const directory = path.join(root, String(index));
      await mkdir(directory);
      const manifest = {
        name: pkg.name,
        version: pkg.version,
        dependencies: pkg.dependencies,
        peerDependencies: pkg.peerDependencies,
        scripts: pkg.scripts,
      };
      await writeFile(path.join(directory, "package.json"), JSON.stringify(manifest));
      for (const [file, content] of Object.entries(pkg.files)) {
        await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
        await writeFile(path.join(directory, file), content);
      }
      const { stdout } = await execCommand("npm", ["pack", "--ignore-scripts", "--json"], {
        cwd: directory,
      });
      const packed: Array<{ filename: string }> = JSON.parse(stdout);
      const artifact = await readFile(path.join(directory, packed[0].filename));
      const artifactPath = `/artifacts/${index}.tgz`;
      artifacts.set(artifactPath, artifact);
      const published = {
        ...manifest,
        dist: {
          tarball: `${url}${artifactPath}`,
          integrity: `sha512-${createHash("sha512").update(artifact).digest("base64")}`,
        },
      };
      const existing = manifests.get(pkg.name) ?? { name: pkg.name, versions: {}, "dist-tags": {} };
      const versions = existing.versions;
      const tags = existing["dist-tags"];
      versions[pkg.version] = published;
      for (const tag of pkg.tags ?? ["latest"]) tags[tag] = pkg.version;
      manifests.set(pkg.name, existing);
    }
  } catch (error) {
    server.closeAllConnections();
    server.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    url,
    userconfig,
    requests,
    env: { npm_config_userconfig: userconfig },
    setTag(packageName: string, tag: string, version: string) {
      const manifest = manifests.get(packageName);
      if (!manifest?.versions[version])
        throw new Error(`Unknown fixture package: ${packageName}@${version}`);
      manifest["dist-tags"][tag] = version;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function npmPluginPackages() {
  const files = {
    "paseo-plugin.json": JSON.stringify({
      id: "npm-review",
      description: "Installed from the npm fixture registry",
      requirements: { paseo: ">=0.4.0" },
    }),
    "index.server.ts": `import value from "paseo-fixture-dependency";
export default function contribute() {
  if (value !== "dependency loaded") throw new Error("Dependency did not resolve");
  console.log(value);
  return () => {};
}`,
  };
  return [
    {
      name: "paseo-fixture-dependency",
      version: "1.0.0",
      files: { "index.js": 'module.exports = "dependency loaded";' },
    },
    {
      name: "paseo-fixture-plugin",
      version: "1.0.0",
      files,
      dependencies: { "paseo-fixture-dependency": "1.0.0" },
      tags: ["stable"],
    },
    {
      name: "paseo-fixture-plugin",
      version: "1.1.0",
      files,
      dependencies: { "paseo-fixture-dependency": "1.0.0" },
      tags: ["latest", "next"],
    },
    {
      name: "@paseo-fixture/review",
      version: "2.0.0",
      files,
      dependencies: { "paseo-fixture-dependency": "1.0.0" },
      peerDependencies: { "@getpaseo/plugin": "*" },
    },
  ];
}
