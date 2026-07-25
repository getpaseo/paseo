function usageAndExit(code = 1) {
  process.stderr.write(
    "Usage: node scripts/emit-fork-identity-env.mjs --owner <github-owner> [--suffix <id-suffix>] [--display-name <name>]\n",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    owner: process.env.GITHUB_REPOSITORY_OWNER ?? "",
    suffix: process.env.PASEO_FORK_ID_SUFFIX ?? "",
    displayName: process.env.PASEO_FORK_DISPLAY_NAME ?? "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--owner") {
      args.owner = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--suffix") {
      args.suffix = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--display-name") {
      args.displayName = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usageAndExit(0);
    }
    usageAndExit();
  }

  if (!args.owner && !args.suffix) {
    usageAndExit();
  }

  return args;
}

function sanitizeIdSegment(segment) {
  const sanitized = segment
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

  if (!sanitized) {
    return "";
  }

  return /^[a-z]/.test(sanitized) ? sanitized : `u${sanitized}`;
}

function normalizeIdSuffix(rawValue) {
  const segments = rawValue
    .split(".")
    .map((segment) => sanitizeIdSegment(segment))
    .filter(Boolean);

  if (segments.length === 0) {
    throw new Error(`Could not derive a valid app id suffix from "${rawValue}"`);
  }

  return segments.join(".");
}

function assertSingleLine(value, label) {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`${label} must be a single line`);
  }
}

const args = parseArgs(process.argv.slice(2));
const rawSuffix = args.suffix || args.owner;
const suffix = normalizeIdSuffix(rawSuffix);
const displayName = (args.displayName || args.owner || suffix).trim();
assertSingleLine(displayName, "display name");

// Default to official product identity so personal forks can replace/update the
// upstream app and publish release assets with the same names as getpaseo/paseo.
// Set env overrides only when a fork intentionally needs a distinct brand.
const entries = [
  ["PASEO_FORK_ID_SUFFIX", suffix],
  ["PASEO_FORK_DISPLAY_NAME", displayName],
  ["PASEO_ANDROID_PACKAGE_ID", process.env.PASEO_ANDROID_PACKAGE_ID || "sh.paseo"],
  ["PASEO_ANDROID_APP_NAME", process.env.PASEO_ANDROID_APP_NAME || "Paseo"],
  ["PASEO_URL_SCHEME", process.env.PASEO_URL_SCHEME || "paseo"],
  ["PASEO_DESKTOP_APP_ID", process.env.PASEO_DESKTOP_APP_ID || "sh.paseo.desktop"],
];

for (const [key, value] of entries) {
  assertSingleLine(value, key);
  process.stdout.write(`${key}=${value}\n`);
}
