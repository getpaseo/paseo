import { createFileRoute } from "@tanstack/react-router";
import { createNewWorkspaceRedirect } from "~/new-workspace-deep-link";

export const Route = createFileRoute("/new")({
  server: {
    handlers: {
      GET: ({ request }) => createNewWorkspaceRedirect(request.url),
    },
  },
});
