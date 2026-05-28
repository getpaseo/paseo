import { createFileRoute } from "@tanstack/react-router";
import { agentRouteOptions } from "~/components/agent-route";

export const Route = createFileRoute("/dimcode")(agentRouteOptions("dimcode"));
