import { createFileRoute } from "@tanstack/react-router";
import { agentRouteOptions } from "~/components/agent-route";

export const Route = createFileRoute("/{-$locale}/claude-code")(agentRouteOptions("claude-code"));
