import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { repositories } from "../shared/repositories";

export function listRepositories({
  mode,
}: RpcInput<typeof repositories>): RpcOutput<typeof repositories> {
  if (mode === "failure")
    return {
      repositories: [],
      error: "Fictional repository access failed; retry the normal request.",
    };
  return {
    repositories:
      mode === "empty"
        ? []
        : [
            { id: "orchard", path: "demo/orchard" },
            { id: "harbor", path: "demo/harbor" },
          ],
    error: null,
  };
}
