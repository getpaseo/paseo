import { describe, expect, it } from "vitest";
import { openWorktreeForm, worktreeFormError, worktreeFormSource } from "./worktree-form-model";
const branch = (refName: string) => ({
  kind: "branch" as const,
  name: refName,
  refName,
  accessibilityLabel: refName,
});
const sourceInput = { cwd: "/repo", projectId: "project", refName: "refs/heads/main" };
describe("worktree form", () => {
  it("defaults names from the checked out branch and retains manual edits across ref and mode changes", () => {
    const form = openWorktreeForm("Feature/My.Change");
    expect(form.getState().worktreeName).toBe("feature-my-change");
    form.setMode("checkout");
    form.applyRef(branch("refs/heads/Release/1.2"));
    expect(form.getState().worktreeName).toBe("release-1-2");
    form.setWorktreeName("my-checkout");
    form.applyRef(branch("refs/heads/other"));
    form.setMode("branch-off");
    form.setBranchName("New/Branch");
    expect(form.getState().worktreeName).toBe("my-checkout");
  });
  it("sends both explicit creation modes and adopts an existing checkout without worktree creation", () => {
    const form = openWorktreeForm("feature/new");
    expect(worktreeFormSource(form.getState(), sourceInput)).toEqual({
      kind: "worktree",
      ...sourceInput,
      action: "branch-off",
      branchName: "feature/new",
      worktreeSlug: "feature-new",
      exactNames: true,
    });
    form.setMode("checkout");
    form.applyRef(branch("refs/heads/feature/existing"));
    expect(worktreeFormSource(form.getState(), sourceInput)).toEqual({
      kind: "worktree",
      cwd: "/repo",
      projectId: "project",
      action: "checkout",
      refName: "feature/existing",
      worktreeSlug: "feature-existing",
      exactNames: true,
    });
    form.selectExisting({ worktreePath: "/existing", branchName: "feature/existing" });
    expect(worktreeFormSource(form.getState(), sourceInput)).toEqual({
      kind: "directory",
      path: "/existing",
      projectId: "project",
    });
    form.applyScope("other-host:other-repo");
    expect(form.getState().existing).toBeNull();
  });
  it.each(["", "../escape", "UPPER", "two--hyphens", "-edge", "x".repeat(51)])(
    "rejects invalid worktree name %s",
    (name) => {
      const form = openWorktreeForm("feature");
      form.setWorktreeName(name);
      expect(worktreeFormError(form.getState(), [])).toContain("Worktree name must");
    },
  );
  it("keeps explicit intent identifiable when moving to an older host", () => {
    const form = openWorktreeForm("default-branch");
    expect(form.requiresCapability()).toBe(false);
    form.setBranchName("chosen-branch");
    form.applyScope("older-host:repo");
    expect(form.requiresCapability()).toBe(true);
    expect(form.getState().branchName).toBe("chosen-branch");
  });
  it("resets repository choices and derived defaults without overwriting manual names", () => {
    const form = openWorktreeForm("fresh-branch");
    form.applyScope("host:repo-a");
    form.setMode("checkout");
    form.applyRef(branch("refs/heads/repo-a-only"));
    form.selectExisting({ worktreePath: "/repo-a-checkout" });
    form.applyScope("host:repo-b");
    expect(form.getState()).toMatchObject({
      mode: "branch-off",
      checkoutBranch: "",
      existing: null,
      worktreeName: "fresh-branch",
    });
    form.setBranchName("chosen-new-branch");
    form.setWorktreeName("chosen-directory");
    form.setMode("checkout");
    form.applyScope("other-host:repo-b");
    expect(form.getState()).toMatchObject({
      mode: "branch-off",
      checkoutBranch: "",
      branchName: "chosen-new-branch",
      worktreeName: "chosen-directory",
    });
  });
  it("requires a branch and identifies the existing checkout when occupied", () => {
    const form = openWorktreeForm("feature");
    form.setBranchName("");
    expect(worktreeFormError(form.getState(), [])).toBe("Enter a new branch name.");
    form.setMode("checkout");
    form.setWorktreeName("checkout");
    expect(worktreeFormError(form.getState(), [])).toBe("Choose an existing branch.");
    form.applyRef(branch("refs/heads/main"));
    expect(
      worktreeFormError(form.getState(), [{ worktreePath: "/repo", branchName: "main" }]),
    ).toContain("Select its existing worktree");
    expect(worktreeFormError(form.getState(), [])).toBeNull();
  });
});
