import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createCodeupService, parseCodeupRemoteIdentity } from "./server/codeup-service";

const execFileAsync = promisify(execFile);

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the real Codeup Forge integration test`);
  }
  return value;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 120_000,
  });
  return result.stdout.trim();
}

async function codeupApi<T>(
  cwd: string,
  action: string,
  parameters: ReadonlyArray<readonly [string, string]>,
): Promise<T> {
  const args = [
    "--region",
    "cn-hangzhou",
    "--endpoint",
    "devops.cn-hangzhou.aliyuncs.com",
    "--language",
    "en",
    "devops",
    action,
  ];
  for (const [name, value] of parameters) args.push(`--${name}`, value);
  const result = await execFileAsync("aliyun", args, { cwd, timeout: 120_000 });
  return JSON.parse(result.stdout) as T;
}

async function eventually<T>(
  operation: () => Promise<T>,
  accept: (value: T) => boolean,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 90_000;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await operation();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Timed out waiting for ${description}; last value: ${JSON.stringify(last)}`);
}

describe("Codeup Forge real integration", () => {
  it("creates, reads, checks out, and squash-merges a new Codeup merge request", async () => {
    const repositoryUrl = requiredEnvironment("CODEUP_E2E_REPOSITORY_URL");
    const baseBranch = requiredEnvironment("CODEUP_E2E_BASE_BRANCH");
    const remoteIdentity = parseCodeupRemoteIdentity(repositoryUrl);
    if (!remoteIdentity) throw new Error("CODEUP_E2E_REPOSITORY_URL is not a Codeup remote");
    const checkout = await mkdtemp(path.join(tmpdir(), "paseo-codeup-e2e-"));
    const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const branch = `paseo/codeup-e2e-${suffix}`;
    const title = `Paseo Codeup Forge E2E ${suffix}`;
    const fixturePath = `.paseo-codeup-e2e-${suffix}.txt`;
    const service = createCodeupService();
    let repositoryId: number | null = null;
    let createdMergeRequestNumber: number | null = null;
    let merged = false;

    try {
      const repositoryResponse = await codeupApi<{
        success?: boolean;
        repository?: { id?: number };
      }>(checkout, "GetRepository", [
        ["organizationId", remoteIdentity.organizationId],
        ["identity", remoteIdentity.repositoryIdentity],
      ]);
      repositoryId = repositoryResponse.repository?.id ?? null;
      if (repositoryResponse.success !== true || repositoryId === null) {
        throw new Error("Codeup did not return the E2E repository id");
      }
      await git(checkout, ["clone", "--branch", baseBranch, repositoryUrl, "."]);
      await git(checkout, ["config", "user.email", "paseo-codeup-e2e@example.invalid"]);
      await git(checkout, ["config", "user.name", "Paseo Codeup E2E"]);
      await git(checkout, ["checkout", "-b", branch]);
      await writeFile(path.join(checkout, fixturePath), `${title}\n`, "utf8");
      await git(checkout, ["add", fixturePath]);
      await git(checkout, ["-c", "commit.gpgsign=false", "commit", "-m", title]);
      const headSha = await git(checkout, ["rev-parse", "HEAD"]);
      await git(checkout, ["push", "-u", "origin", branch]);

      await expect(service.isAuthenticated({ cwd: checkout })).resolves.toBe(true);
      const created = await service.createPullRequest({
        cwd: checkout,
        title,
        body: "Created by the Paseo Codeup Forge real integration test.",
        head: branch,
        base: baseBranch,
      });
      createdMergeRequestNumber = created.number;
      expect(created.number).toBeGreaterThan(0);
      expect(created.url).toContain("codeup.aliyun.com");

      await expect(
        service.listPullRequests({ cwd: checkout, query: title, limit: 10 }),
      ).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ number: created.number })]),
      );
      await expect(
        service.searchIssuesAndPrs({
          cwd: checkout,
          query: title,
          kinds: ["change_request"],
          limit: 10,
        }),
      ).resolves.toMatchObject({
        authState: "authenticated",
        items: expect.arrayContaining([expect.objectContaining({ number: created.number })]),
      });
      await expect(
        service.searchIssuesAndPrs({ cwd: checkout, query: title, kinds: ["issue"] }),
      ).resolves.toMatchObject({ authState: "authenticated", items: [] });

      const status = await eventually(
        () =>
          service.getCurrentPullRequestStatus({
            cwd: checkout,
            headRef: branch,
            headSha,
            force: true,
            reason: "Codeup real integration MR readiness",
          }),
        (value) =>
          value?.forgeSpecific?.forge === "codeup" &&
          value.forgeSpecific.status === "TO_BE_MERGED" &&
          value.forgeSpecific.allRequirementsPass === true,
        "Codeup MR readiness",
      );
      expect(status).toMatchObject({
        number: created.number,
        headRefName: branch,
        forgeSpecific: { forge: "codeup", allRequirementsPass: true },
      });
      expect(Array.isArray(status?.checks)).toBe(true);

      const timeline = await service.getPullRequestTimeline({
        cwd: checkout,
        prNumber: created.number,
        repoOwner: "codeup",
        repoName: "e2e",
      });
      expect(timeline.error).toBeNull();
      expect(Array.isArray(timeline.items)).toBe(true);

      const detailedCheck = status?.checks.find((check) => check.checkRunId !== undefined);
      if (detailedCheck?.checkRunId !== undefined) {
        await expect(
          service.getCheckDetails({
            cwd: checkout,
            repoOwner: remoteIdentity.organizationId,
            repoName: remoteIdentity.repositoryIdentity,
            checkRunId: detailedCheck.checkRunId,
          }),
        ).resolves.toMatchObject({ checkRunId: detailedCheck.checkRunId });
      }

      const target = await service.getPullRequestCheckoutTarget({
        cwd: checkout,
        number: created.number,
      });
      const checkoutRef = target.checkoutRefs?.[0];
      expect(checkoutRef).toBeDefined();
      if (!checkoutRef) throw new Error("Codeup did not provide a checkout ref");
      const fetchSource = checkoutRef.remoteUrl ?? checkoutRef.remoteName ?? "origin";
      await git(checkout, [
        "fetch",
        fetchSource,
        `+${checkoutRef.remoteRef}:refs/remotes/paseo-codeup-e2e/head`,
        "--force",
      ]);
      await expect(
        git(checkout, ["rev-parse", "refs/remotes/paseo-codeup-e2e/head"]),
      ).resolves.toBe(headSha);

      await expect(
        service.mergePullRequest({
          cwd: checkout,
          prNumber: created.number,
          mergeMethod: "squash",
          status: { forgeSpecific: status?.forgeSpecific },
        }),
      ).resolves.toEqual({ success: true });
      merged = true;
      await eventually(
        () => service.getPullRequest({ cwd: checkout, number: created.number }),
        (value) => value.state === "merged",
        "Codeup MR merge completion",
      );
    } finally {
      try {
        if (createdMergeRequestNumber !== null && repositoryId !== null && !merged) {
          await codeupApi(checkout, "CloseMergeRequest", [
            ["organizationId", remoteIdentity.organizationId],
            ["repositoryId", String(repositoryId)],
            ["localId", String(createdMergeRequestNumber)],
          ]);
        }
      } finally {
        await git(checkout, ["push", "origin", "--delete", branch]).catch(() => undefined);
        service.invalidate({ cwd: checkout });
        await rm(checkout, { recursive: true, force: true });
      }
    }
  }, 240_000);
});
