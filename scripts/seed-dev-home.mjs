import {
  cpSync,
  realpathSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function seedPaseoHome(source, target) {
  if (!existsSync(source)) {
    console.log(`  Seed:    skipped (${source} missing)`);
    return;
  }

  if (source === target) {
    console.log("  Seed:    skipped (source is target)");
    return;
  }

  if (process.env.PASEO_DEV_RESET_HOME !== "1" && hasEntries(target)) {
    console.log(`  Seed:    skipped (${target} already has data)`);
    return;
  }

  const configPath = join(source, "config.json");
  const config = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""))
    : { version: 1 };

  if (process.env.PASEO_DEV_RESET_HOME === "1") {
    rmSync(target, { recursive: true, force: true });
  }

  mkdirSync(target, { recursive: true });
  console.log(`  Seed:    copying metadata from ${source}`);
  copyJsonTree(join(source, "agents"), join(target, "agents"));
  copyJsonTree(join(source, "projects"), join(target, "projects"));

  // A snapshot does not own the source daemon's pending work. Recovery normalizes
  // copied running records on startup without sending a prompt when disabled.
  config.agents = { ...config.agents, resumeOnStartup: false };
  writeFileSync(join(target, "config.json"), JSON.stringify(config, null, 2));

  console.log(`  Seed:    copied metadata from ${source}`);
}

// Durable JSON metadata only. Runtime files (pid files, sockets, logs) must not be copied.
function copyJsonTree(source, target) {
  if (!existsSync(source)) {
    return;
  }

  cpSync(source, target, {
    recursive: true,
    dereference: true,
    filter: (path) => isDirectory(path) || path.endsWith(".json"),
  });
}

function hasEntries(path) {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  seedPaseoHome(process.argv[2], process.argv[3]);
}
