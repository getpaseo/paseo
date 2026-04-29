import { describe, expect, test, vi } from "vitest";

import { execCommand } from "../../../utils/spawn.js";
import { JulesRepoError, resolveGitHubRepo } from "./jules-repo.js";

vi.mock("../../../utils/spawn.js", () => ({
  execCommand: vi.fn(),
}));

describe("resolveGitHubRepo", () => {
  test("parses https origin remote", async () => {
    vi.mocked(execCommand).mockResolvedValueOnce({
      stdout: "https://github.com/getpaseo/paseo.git\n",
      stderr: "",
    });

    const result = await resolveGitHubRepo("/tmp/repo", {
      resolveRepoRoot: vi.fn(async () => "/tmp/repo"),
    });

    expect(result).toEqual({ owner: "getpaseo", name: "paseo" });
  });

  test("parses ssh origin remote", async () => {
    vi.mocked(execCommand).mockResolvedValueOnce({
      stdout: "git@github.com:getpaseo/paseo.git\n",
      stderr: "",
    });

    const result = await resolveGitHubRepo("/tmp/repo", {
      resolveRepoRoot: vi.fn(async () => "/tmp/repo"),
    });

    expect(result).toEqual({ owner: "getpaseo", name: "paseo" });
  });

  test("throws on non github origin", async () => {
    vi.mocked(execCommand).mockResolvedValueOnce({
      stdout: "git@gitlab.com:getpaseo/paseo.git\n",
      stderr: "",
    });

    await expect(
      resolveGitHubRepo("/tmp/repo", {
        resolveRepoRoot: vi.fn(async () => "/tmp/repo"),
      }),
    ).rejects.toBeInstanceOf(JulesRepoError);
  });
});
