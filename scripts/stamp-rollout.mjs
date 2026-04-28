import fs from "node:fs";
import { dump, load } from "js-yaml";

export function stampRollout({ releaseDate, rolloutHours }, paths) {
  if (releaseDate === undefined && rolloutHours === undefined) {
    throw new Error("stampRollout requires at least one of releaseDate or rolloutHours");
  }
  for (const filePath of paths) {
    const manifest = load(fs.readFileSync(filePath, "utf8")) ?? {};
    const next = { ...manifest };
    if (releaseDate !== undefined) next.releaseDate = releaseDate;
    if (rolloutHours !== undefined) next.rolloutHours = rolloutHours;
    fs.writeFileSync(filePath, dump(next, { lineWidth: -1, noRefs: true }));
  }
}

function parseArgs(argv) {
  const opts = {};
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--release-date") {
      opts.releaseDate = argv[++i];
    } else if (arg === "--rollout-hours") {
      const raw = argv[++i];
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`--rollout-hours must be a non-negative number, got ${raw}`);
      }
      opts.rolloutHours = parsed;
    } else {
      paths.push(arg);
    }
  }
  return { opts, paths };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { opts, paths } = parseArgs(process.argv.slice(2));
  if (paths.length === 0 || (opts.releaseDate === undefined && opts.rolloutHours === undefined)) {
    throw new Error(
      "Usage: node scripts/stamp-rollout.mjs [--release-date <iso>] [--rollout-hours <n>] <yaml-path>...",
    );
  }
  stampRollout(opts, paths);
}
