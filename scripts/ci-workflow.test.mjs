import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);
const ciWorkflowPath = new URL(".github/workflows/ci.yml", repoRoot);
const dockerWorkflowPath = new URL(".github/workflows/docker.yml", repoRoot);
const nixWorkflowPath = new URL(".github/workflows/nix.yml", repoRoot);
const filtersPath = new URL(".github/ci-paths.yml", repoRoot);

const requiredCiJobs = new Map([
  ["format", { name: "format", contract: "format" }],
  ["lint", { name: "lint", contract: "quality" }],
  ["typecheck", { name: "typecheck", contract: "quality" }],
  ["server-tests-ubuntu", { name: "server-tests (ubuntu-latest)", contract: "server" }],
  ["server-tests-windows", { name: "server-tests (windows-latest)", contract: "server" }],
  ["desktop-tests-ubuntu", { name: "desktop-tests (ubuntu-latest)", contract: "desktop" }],
  ["desktop-tests-windows", { name: "desktop-tests (windows-latest)", contract: "desktop" }],
  ["app-tests", { name: "app-tests", contract: "app" }],
  ["sdk-tests", { name: "sdk-tests", contract: "sdk" }],
  ["playwright-1", { name: "playwright (shard 1/4)", contract: "playwright" }],
  ["playwright-2", { name: "playwright (shard 2/4)", contract: "playwright" }],
  ["playwright-3", { name: "playwright (shard 3/4)", contract: "playwright" }],
  ["playwright-4", { name: "playwright (shard 4/4)", contract: "playwright" }],
  ["playwright-desktop", { name: "playwright (desktop overlay)", contract: "playwright_desktop" }],
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
  return filters[filterName].some((pattern) => matchesGlob(changedPath, pattern));
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

test("required checks are statically named jobs with real job-level gating", () => {
  const workflowSource = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(workflowSource);

  assert.doesNotMatch(workflowSource, /strategy:\s*\n\s+matrix:/);
  assert.doesNotMatch(workflowSource, /RUN_TESTS|Skip unaffected|No .* changes detected/);

  for (const [jobId, expected] of requiredCiJobs) {
    const job = jobs.get(jobId)?.join("\n");
    assert.ok(job, `missing static job ${jobId}`);
    assert.match(job, new RegExp(`^    name: ${expected.name.replace(/[()]/g, "\\$&")}$`, "m"));
    assert.match(job, /needs\.changes\.outputs\.full != 'false'/);
    assert.match(job, new RegExp(`needs\\.changes\\.outputs\\.${expected.contract} != 'false'`));
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

test("PR routing follows test contracts instead of package consumers", () => {
  const filters = loadFilters(filtersPath);
  const cases = new Map([
    ["packages/app/src/components/message.tsx", ["app", "format", "playwright", "quality"]],
    ["packages/server/src/server/bootstrap.ts", ["format", "playwright", "quality", "server"]],
    ["packages/cli/src/commands/agent/ls.ts", ["cli", "format", "quality"]],
    ["packages/desktop/src/main.ts", ["desktop", "format", "playwright_desktop", "quality"]],
    ["packages/protocol/src/messages.ts", ["format", "quality", "sdk"]],
    ["packages/client/src/client.ts", ["format", "quality", "sdk"]],
    ["packages/relay/src/index.ts", ["format", "quality", "relay"]],
    ["docker/base/Dockerfile", ["docker"]],
    ["nix/package.nix", ["nix"]],
  ]);

  for (const [changedPath, expected] of cases) {
    assert.deepEqual(affectedContracts(filters, changedPath), expected, changedPath);
  }
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
  ]) {
    assert.deepEqual(affectedContracts(filters, changedPath), allContracts, changedPath);
  }
});

test("Docker and Nix required jobs use job-level gates instead of workflow path filters", () => {
  for (const [workflowPath, jobId, output] of [
    [dockerWorkflowPath, "build", "docker"],
    [nixWorkflowPath, "build", "nix"],
  ]) {
    const source = readFileSync(workflowPath, "utf8");
    const trigger = source.split("jobs:", 1)[0];
    const job = jobBlocks(source).get(jobId)?.join("\n");
    assert.doesNotMatch(trigger, /^\s+paths:\s*$/m);
    assert.match(job, new RegExp(`outputs\\.${output} != 'false'`));
  }
});
