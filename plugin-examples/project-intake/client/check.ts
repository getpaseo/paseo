import type { PluginClientContext, PluginSubmissionCheckInput } from "@getpaseo/plugin/client";
import { assessProject, resolveProject } from "../shared/contracts";

export function registerProjectCheck(client: PluginClientContext): () => void {
  if (typeof client.addSubmissionCheck !== "function") return () => {};
  return client.addSubmissionCheck({
    id: "project-fit",
    async check(input: PluginSubmissionCheckInput, { signal }) {
      if (signal.aborted) throw new Error("Project check cancelled.");
      const assessment = await client.rpc(assessProject, {
        cwd: input.cwd,
        projectId: input.projectId,
        projectName: input.projectName,
        projectRootPath: input.projectRootPath,
        text: input.text,
        executionId: input.executionId,
        idempotencyKey: input.idempotencyKey,
      });
      if (signal.aborted) throw new Error("Project check cancelled.");
      if (!assessment.showDecision) return;
      return {
        title: "Which project should do this work?",
        description: `${assessment.explanation}\nNew projects are created in ${assessment.parentPath}. Your selected model and request stay the same.`,
        choices: [
          {
            id: "current",
            title: "Keep current project",
            description: `Continue in ${assessment.currentName}.`,
          },
          {
            id: "new",
            title: "Create a separate project",
            description: "Create a new Git project and start the original request there.",
          },
        ],
        textInput: {
          label: "New project name",
          initialValue: assessment.proposedName,
          placeholder: "my-product",
        },
        ...(assessment.timeout ? { timeout: assessment.timeout } : {}),
      };
    },
    async resolve(input, choice, { signal }) {
      if (signal.aborted) throw new Error("Project check cancelled.");
      if (choice.choiceId !== "current" && choice.choiceId !== "new")
        throw new Error("Choose the current or a new project.");
      const target = await client.rpc(resolveProject, {
        idempotencyKey: input.idempotencyKey,
        ...choice,
        choiceId: choice.choiceId,
      });
      if (signal.aborted) throw new Error("Project check cancelled.");
      return target ?? undefined;
    },
  });
}
