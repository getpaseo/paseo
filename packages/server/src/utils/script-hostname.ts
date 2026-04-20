import { slugify } from "./worktree.js";

type BuildScriptHostnameOptions = {
  projectSlug: string;
  branchName: string | null;
  scriptName: string;
};

function toHostnameLabel(value: string): string {
  return slugify(value) || "untitled";
}

export function buildScriptHostname({
  projectSlug,
  branchName,
  scriptName,
}: BuildScriptHostnameOptions): string {
  const serviceHostnameLabel = toHostnameLabel(scriptName);
  const projectHostnameLabel = toHostnameLabel(projectSlug);
  const isDefaultBranch = branchName === null || branchName === "main" || branchName === "master";

  if (isDefaultBranch) {
    return `${serviceHostnameLabel}.${projectHostnameLabel}.localhost`;
  }

  return `${serviceHostnameLabel}.${toHostnameLabel(branchName)}.${projectHostnameLabel}.localhost`;
}
