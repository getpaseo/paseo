import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import type { AgentRoutingPolicy } from "../messages.js";
import type { ProfileRoute, ProfileRouter } from "./profile-routing.js";

export interface TurnRouteInput {
  provider: string;
  cwd: string;
  model: string | undefined;
  thinkingOptionId: string | undefined;
  prompt: AgentPromptInput;
  isFirstTurn: boolean;
  routingMode?: "auto" | "manual";
  routingPolicy?: AgentRoutingPolicy;
}
export type TurnRoute = ProfileRoute;
export type TurnRouter = (input: TurnRouteInput) => Promise<TurnRoute | null>;

export function createSystemOneTurnRouter(options: { profileRouter: ProfileRouter }): TurnRouter {
  return (input) =>
    input.routingMode === "auto"
      ? options.profileRouter({ ...input, explicitEffort: input.thinkingOptionId === "max" })
      : Promise.resolve(null);
}
