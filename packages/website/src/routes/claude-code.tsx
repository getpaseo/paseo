import { createFileRoute } from "@tanstack/react-router";
import { agentRouteOptions } from "~/components/agent-route";

export const Route = createFileRoute("/claude-code")(agentRouteOptions("claude-code"));
