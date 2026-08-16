import type { BoundWorkspaceRuntime } from "./workspace-runtime/index.js";
import { observeGitCommonMetadata } from "./workspace-runtime/git-observation/index.js";

export async function observeWorkspaceGit(
  runtime: BoundWorkspaceRuntime,
  listener: () => void,
): Promise<{ unsubscribe(): Promise<void> }> {
  let ready = false;
  const workingTree = await runtime.files.subscribe(
    { paths: ["."], recursive: true, ignoredPaths: [".git"] },
    (event) => {
      if (ready && event.type !== "error") listener();
    },
  );

  let commonRefs: { unsubscribe(): Promise<void> } | null = null;
  try {
    commonRefs = await observeGitCommonMetadata(runtime, () => {
      if (ready) listener();
    });
    ready = true;
  } catch (error) {
    await workingTree.unsubscribe();
    throw error;
  }

  let closed = false;
  return {
    async unsubscribe() {
      if (closed) return;
      closed = true;
      await Promise.all([workingTree.unsubscribe(), commonRefs?.unsubscribe()]);
    },
  };
}
