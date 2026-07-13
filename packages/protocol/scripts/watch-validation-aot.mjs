import { readdir, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const protocolSrcDir = join(packageRoot, "src");
const pollIntervalMs = 1000;

let currentFingerprint = "";
let generateInFlight = false;
let generateAgain = false;

async function collectSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    const relativePath = relative(protocolSrcDir, path);
    const parts = relativePath.split(sep);

    if (parts[0] === "generated") {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(path)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files;
}

async function fingerprintSources() {
  const files = await collectSourceFiles(protocolSrcDir);
  const stats = await Promise.all(
    files.sort().map(async (file) => {
      const fileStat = await stat(file);
      return `${relative(packageRoot, file)}:${fileStat.mtimeMs}:${fileStat.size}`;
    }),
  );

  return stats.join("\n");
}

function runGenerate() {
  if (generateInFlight) {
    generateAgain = true;
    return;
  }

  generateInFlight = true;
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npmCommand, ["run", "generate:validators"], {
    cwd: packageRoot,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    generateInFlight = false;
    if (code !== 0) {
      console.error(
        signal
          ? `validation AOT generation stopped by ${signal}`
          : `validation AOT generation failed with exit code ${code}`,
      );
    }

    if (generateAgain) {
      generateAgain = false;
      runGenerate();
    }
  });
}

async function poll() {
  try {
    const nextFingerprint = await fingerprintSources();
    if (currentFingerprint && nextFingerprint !== currentFingerprint) {
      runGenerate();
    }
    currentFingerprint = nextFingerprint;
  } catch (error) {
    console.error("validation AOT watcher failed to scan protocol sources", error);
  }
}

currentFingerprint = await fingerprintSources();
console.log("Watching protocol schema sources for validation AOT changes...");
setInterval(poll, pollIntervalMs);
