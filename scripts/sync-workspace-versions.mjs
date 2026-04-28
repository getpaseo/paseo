import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const rootPackagePath = path.join(rootDir, "package.json");

const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));
const rootVersion = rootPackage.version;
const workspacePaths = Array.isArray(rootPackage.workspaces) ? rootPackage.workspaces : [];
const sharedMetadata = {
  homepage: rootPackage.homepage,
  repository: rootPackage.repository,
  author: rootPackage.author,
  license: rootPackage.license,
};

if (typeof rootVersion !== "string" || rootVersion.length === 0) {
  throw new Error('Root package.json must contain a valid "version"');
}

const dependencySections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const touched = [];

for (const workspacePath of workspacePaths) {
  const packagePath = path.join(rootDir, workspacePath, "package.json");
  if (!existsSync(packagePath)) {
    continue;
  }

  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  let changed = false;

  if (pkg.version !== rootVersion) {
    pkg.version = rootVersion;
    changed = true;
  }

  if (pkg.name === "@hubcode/desktop") {
    for (const [field, value] of Object.entries(sharedMetadata)) {
      const currentValue = JSON.stringify(pkg[field]);
      const nextValue = JSON.stringify(value);
      if (currentValue !== nextValue) {
        pkg[field] = value;
        changed = true;
      }
    }
  }

  for (const section of dependencySections) {
    const deps = pkg[section];
    if (!deps || typeof deps !== "object") {
      continue;
    }

    for (const name of Object.keys(deps)) {
      if (!name.startsWith("@hubcode/")) {
        continue;
      }
      if (name === pkg.name) {
        continue;
      }
      if (deps[name] !== rootVersion) {
        deps[name] = rootVersion;
        changed = true;
      }
    }
  }

  if (changed) {
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    touched.push(path.relative(rootDir, packagePath));
  }
}

if (touched.length === 0) {
  console.log(`Workspace versions and internal deps already synced to ${rootVersion}`);
} else {
  console.log(`Synced to ${rootVersion}:`);
  for (const file of touched) {
    console.log(`- ${file}`);
  }
}
