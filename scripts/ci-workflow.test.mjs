import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { matchesGlob, relative as relativePath } from "node:path";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);
const ciWorkflowPath = new URL(".github/workflows/ci.yml", repoRoot);
const dockerWorkflowPath = new URL(".github/workflows/docker.yml", repoRoot);
const nixWorkflowPath = new URL(".github/workflows/nix.yml", repoRoot);
const filtersPath = new URL(".github/ci-paths.yml", repoRoot);
const serverTsconfigPath = new URL("packages/server/tsconfig.server.json", repoRoot);
const desktopPackagePath = new URL("packages/desktop/package.json", repoRoot);

const gatedCiJobs = new Map([
  ["format", { name: "format", contract: "format" }],
  ["lint", { name: "lint", contract: "quality" }],
  ["typecheck", { name: "typecheck", contract: "quality" }],
  ["server-tests-ubuntu", { name: "server-tests (ubuntu-latest)", contracts: ["server", "hub"] }],
  ["server-tests-windows", { name: "server-tests (windows-latest)", contracts: ["server", "hub"] }],
  ["desktop-tests-ubuntu", { name: "desktop-tests (ubuntu-latest)", contract: "desktop" }],
  ["desktop-tests-windows", { name: "desktop-tests (windows-latest)", contract: "desktop" }],
  ["app-tests", { name: "app-tests", contract: "app" }],
  ["sdk-tests", { name: "sdk-tests", contract: "sdk" }],
  ["playwright-1", { name: "playwright (shard 1/4)", contract: "browser" }],
  ["playwright-2", { name: "playwright (shard 2/4)", contract: "browser" }],
  ["playwright-3", { name: "playwright (shard 3/4)", contract: "browser" }],
  ["playwright-4", { name: "playwright (shard 4/4)", contract: "browser" }],
  ["relay-tests", { name: "relay-tests", contract: "relay" }],
  ["cli-tests-1", { name: "cli-tests (shard 1/3)", contract: "cli" }],
  ["cli-tests-2", { name: "cli-tests (shard 2/3)", contract: "cli" }],
  ["cli-tests-3", { name: "cli-tests (shard 3/3)", contract: "cli" }],
]);

function jobBlocks(source) {
  const jobs = new Map();
  let currentJob;

  for (const line of source.split("\n")) {
    const jobMatch = /^  ([a-z0-9-]+):\s*$/.exec(line);
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs.set(currentJob, []);
      continue;
    }
    if (currentJob) jobs.get(currentJob).push(line);
  }
  return jobs;
}

function loadFilters(path) {
  const filters = {};
  let currentFilter;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const filterMatch = /^([a-z_]+):\s*$/.exec(line);
    if (filterMatch) {
      currentFilter = filterMatch[1];
      filters[currentFilter] = [];
      continue;
    }
    const patternMatch = /^  - "([^"]+)"\s*$/.exec(line);
    if (currentFilter && patternMatch) filters[currentFilter].push(patternMatch[1]);
  }
  return filters;
}

function matchesFilter(filters, filterName, changedPath) {
  const visiblePath = exposeDotSegments(changedPath);
  return filters[filterName].some((pattern) =>
    matchesGlob(visiblePath, exposeDotSegments(pattern)),
  );
}

// dorny/paths-filter uses picomatch with `dot: true`. Node's dependency-free
// matcher hides dot-prefixed path segments by default, so make those segments
// ordinary in both operands before matching.
function exposeDotSegments(value) {
  return value.replace(/(^|\/)\./g, "$1__dot__");
}

function filesUnder(relativeDirectory, predicate) {
  const directory = new URL(`${relativeDirectory}/`, repoRoot);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      [relativeDirectory, relativePath(directory.pathname, entry.parentPath), entry.name]
        .filter(Boolean)
        .join("/")
        .replaceAll("\\", "/"),
    )
    .filter(predicate)
    .sort();
}

function affectedContracts(filters, changedPath) {
  const direct = Object.keys(filters).filter((filterName) =>
    matchesFilter(filters, filterName, changedPath),
  );
  const contracts = Object.keys(filters).filter(
    (filterName) => !["routing", "workspace", "ci"].includes(filterName),
  );
  if (direct.some((filterName) => ["routing", "workspace"].includes(filterName))) {
    return contracts.sort();
  }
  return direct.filter((filterName) => !["routing", "workspace", "ci"].includes(filterName)).sort();
}

test("gated checks are statically named jobs with real job-level gating", () => {
  const workflowSource = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(workflowSource);

  assert.doesNotMatch(workflowSource, /strategy:\s*\n\s+matrix:/);
  assert.doesNotMatch(workflowSource, /RUN_TESTS|Skip unaffected|No .* changes detected/);

  for (const [jobId, expected] of gatedCiJobs) {
    const job = jobs.get(jobId)?.join("\n");
    assert.ok(job, `missing static job ${jobId}`);
    assert.match(job, new RegExp(`^    name: ${expected.name.replace(/[()]/g, "\\$&")}$`, "m"));
    assert.match(job, /needs\.changes\.outputs\.full != 'false'/);
    for (const contract of expected.contracts ?? [expected.contract]) {
      assert.match(job, new RegExp(`needs\\.changes\\.outputs\\.${contract} != 'false'`));
    }
  }
});

test("change gating allows superseded workflow runs to cancel", () => {
  for (const workflowPath of [ciWorkflowPath, dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    assert.doesNotMatch(
      source,
      /\$\{\{\s*always\(\)/,
      "always() keeps jobs alive after concurrency cancellation; use !cancelled() for fail-open gating",
    );
  }
});

test("focused contracts stay inside existing required checks", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const changes = jobs.get("changes")?.join("\n") ?? "";
  const server = jobs.get("server-tests-ubuntu")?.join("\n") ?? "";
  const desktop = jobs.get("desktop-tests-ubuntu")?.join("\n") ?? "";

  assert.match(changes, /scripts\/daemon-launch-contract\.test\.mjs/);
  assert.doesNotMatch(changes, /Install dependencies|npm run build/);

  assert.match(server, /test:hub-cli-contract/);
  assert.match(server, /npm run test --workspace=@getpaseo\/server/);
  assert.ok(!jobs.has("hub-cli-contract"));

  assert.match(desktop, /test:e2e:renderer/);
  assert.match(desktop, /test:e2e:browser-tabs/);
  assert.match(desktop, /npm run test --workspace=@getpaseo\/desktop/);
  assert.ok(!jobs.has("desktop-browser-bridge"));
  assert.ok(!jobs.has("playwright-desktop"));
});

test("server builds exclude test utilities at every domain depth", () => {
  const tsconfig = JSON.parse(readFileSync(serverTsconfigPath, "utf8"));
  assert.ok(tsconfig.exclude.includes("src/server/**/test-utils/**"));
  assert.ok(!tsconfig.exclude.includes("src/server/test-utils/**"));
});

test("PR routing follows test contracts instead of package consumers", () => {
  const filters = loadFilters(filtersPath);
  const cases = new Map([
    ["packages/app/src/components/message.tsx", ["app", "browser", "format", "quality"]],
    ["packages/server/src/server/bootstrap.ts", ["format", "quality", "server"]],
    ["packages/cli/src/commands/agent/ls.ts", ["cli", "format", "quality"]],
    ["packages/desktop/src/main.ts", ["desktop", "format", "quality"]],
    [
      "packages/app/src/desktop/browser/pane/index.electron.tsx",
      ["app", "desktop", "format", "quality"],
    ],
    ["packages/cli/src/commands/hub/index.ts", ["cli", "format", "hub", "quality"]],
    [
      "packages/server/src/server/hub/relationship-controller.ts",
      ["format", "hub", "quality", "server"],
    ],
    ["packages/protocol/src/messages.ts", ["format", "quality", "sdk"]],
    ["packages/client/src/client.ts", ["format", "quality", "sdk"]],
    ["packages/highlight/src/index.ts", ["format", "quality", "sdk"]],
    ["packages/expo-two-way-audio/ios/AudioEngine.swift", ["app", "format", "quality"]],
    ["packages/relay/src/index.ts", ["format", "quality", "relay"]],
    ["docker/base/Dockerfile", []],
    ["nix/package.nix", []],
  ]);

  for (const [changedPath, expected] of cases) {
    assert.deepEqual(affectedContracts(filters, changedPath), expected, changedPath);
  }
});

test("tooling and domain contracts use stable ownership boundaries", () => {
  const filters = loadFilters(filtersPath);
  const cases = new Map([
    ["public-docs/cli.md", ["format"]],
    ["skills/paseo/SKILL.md", ["format"]],
    [".github/PULL_REQUEST_TEMPLATE.md", ["format"]],
    [".agents/skills/release-beta/SKILL.md", ["format"]],
    ["docker/docker-compose.example.yml", ["format"]],
    [
      "packages/app/e2e/support/helpers/project-picker-ui.ts",
      ["app", "browser", "desktop", "format", "quality"],
    ],
    [
      "packages/app/e2e/support/global-setup.ts",
      ["app", "browser", "desktop", "format", "quality"],
    ],
    ["packages/desktop/src/daemon/runtime-paths.ts", ["desktop", "format", "quality"]],
    ["packages/desktop/src/features/browser-profile.ts", ["desktop", "format", "quality"]],
    [
      "packages/server/src/server/browser-tools/broker.ts",
      ["desktop", "format", "quality", "server"],
    ],
    [
      "packages/app/src/desktop/browser/resident-webviews.ts",
      ["app", "desktop", "format", "quality"],
    ],
    ["packages/app/e2e/browser/startup-loading.spec.ts", ["app", "browser", "format", "quality"]],
    ["packages/desktop/e2e/startup.spec.ts", ["desktop", "format", "quality"]],
  ]);

  for (const [changedPath, expected] of cases) {
    assert.deepEqual(affectedContracts(filters, changedPath), expected, changedPath);
  }
});

test("cross-package invariants live in the suite that owns them", () => {
  const cliTests = filesUnder("packages/cli", (path) => path.endsWith(".test.ts"));
  assert.ok(cliTests.length > 0);
  for (const path of cliTests) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /server\/src\/server\/test-utils/,
      path,
    );
  }

  const protocolWireCompatibility = new URL(
    "packages/protocol/src/messages.wire-compat.test.ts",
    repoRoot,
  );
  assert.match(readFileSync(protocolWireCompatibility, "utf8"), /wire schema compatibility/);
});

test("browser and desktop tests have exclusive, directory-owned suites", () => {
  const filters = loadFilters(filtersPath);
  const browserSpecs = filesUnder("packages/app/e2e", (path) => path.endsWith(".spec.ts"));
  const desktopSpecs = filesUnder("packages/desktop/e2e", (path) => path.endsWith(".spec.ts"));
  const electronModules = filesUnder("packages/app/src", (path) => /\.electron\.tsx?$/.test(path));

  assert.ok(browserSpecs.length > 0);
  assert.ok(desktopSpecs.length > 0);
  assert.ok(browserSpecs.every((path) => path.startsWith("packages/app/e2e/browser/")));
  assert.ok(desktopSpecs.every((path) => path.startsWith("packages/desktop/e2e/")));
  assert.ok(electronModules.every((path) => path.startsWith("packages/app/src/desktop/")));

  const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
  assert.match(desktopPackage.scripts.test, /--exclude ["']e2e\/\*\*["']/);

  for (const path of browserSpecs) {
    assert.equal(matchesFilter(filters, "browser", path), true, path);
    assert.equal(matchesFilter(filters, "desktop", path), false, path);
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /paseoDesktop|injectDesktopBridge/,
    );
  }
  for (const path of desktopSpecs) {
    assert.equal(matchesFilter(filters, "desktop", path), true, path);
    assert.equal(matchesFilter(filters, "browser", path), false, path);
  }

  const routingSource = readFileSync(filtersPath, "utf8");
  assert.doesNotMatch(routingSource, /desktop_bridge|playwright_desktop|browser-\*|browser-\*\//);
  assert.deepEqual(filters.desktop, [
    "packages/desktop/**",
    "packages/app/src/desktop/**",
    "packages/server/src/server/browser-tools/**",
    "packages/app/e2e/support/**",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
  assert.deepEqual(filters.browser, [
    "packages/app/src/!(desktop)/**",
    "packages/app/e2e/browser/**",
    "packages/app/e2e/support/**",
    "packages/app/assets/**",
    "packages/app/public/**",
    "packages/app/index.ts",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
});

test("root dependency and CI infrastructure changes run every contract", () => {
  const filters = loadFilters(filtersPath);
  const allContracts = Object.keys(filters)
    .filter((filterName) => !["routing", "workspace", "ci"].includes(filterName))
    .sort();

  for (const changedPath of [
    "package.json",
    "package-lock.json",
    ".github/ci-paths.yml",
    "scripts/npm-retry.mjs",
    "scripts/postinstall-patches.mjs",
    "scripts/clean-package-dist.mjs",
    "vitest.config.ts",
  ]) {
    assert.deepEqual(affectedContracts(filters, changedPath), allContracts, changedPath);
  }
});

test("non-required Docker and Nix workflows avoid runners with workflow path filters", () => {
  for (const workflowPath of [dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    const trigger = source.split("jobs:", 1)[0];
    assert.match(trigger, /^\s+paths:\s*$/m);
    assert.doesNotMatch(source, /dorny\/paths-filter/);
  }
});
