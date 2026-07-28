import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);

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

    if (currentJob && (/^    \S/.test(line) || /^      \S/.test(line))) {
      jobs.get(currentJob).push(line);
    }
  }

  return jobs;
}

test("matrix jobs expand before change gating", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const gatedMatrixJobs = [...jobBlocks(workflow)]
    .filter(([, lines]) => {
      const hasMatrix = lines.some((line) => line.startsWith("      matrix:"));
      const unsafeJobCondition = lines.some(
        (line) => line.startsWith("    if:") && line.trim() !== "if: ${{ !cancelled() }}",
      );
      return hasMatrix && unsafeJobCondition;
    })
    .map(([jobId]) => jobId);

  assert.deepEqual(
    gatedMatrixJobs,
    [],
    "change-based job conditions skip a matrix before GitHub can emit its interpolated check names",
  );
});

test("change gating allows superseded workflow runs to cancel", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const cancellationBlockingJobs = [...jobBlocks(workflow)]
    .filter(([, lines]) => lines.some((line) => line.trim().startsWith("${{ always()")))
    .map(([jobId]) => jobId);

  assert.deepEqual(
    cancellationBlockingJobs,
    [],
    "always() keeps jobs alive after concurrency cancellation; use !cancelled() for fail-open gating",
  );
});
