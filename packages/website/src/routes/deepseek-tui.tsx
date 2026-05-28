import { createFileRoute } from "@tanstack/react-router";
import { agentRouteOptions } from "~/components/agent-route";

export const Route = createFileRoute("/deepseek-tui")(agentRouteOptions("deepseek-tui"));
