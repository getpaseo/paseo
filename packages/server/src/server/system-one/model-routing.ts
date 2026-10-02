import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import type { ProfileRoute, ProfileRouter } from "./profile-routing.js";

export interface TurnRouteInput {
  provider: string;
  cwd: string;
  model: string | undefined;
  thinkingOptionId: string | undefined;
  prompt: AgentPromptInput;
  isFirstTurn: boolean;
}
export type TurnRoute = ProfileRoute;
export type TurnRouter = (input: TurnRouteInput) => Promise<TurnRoute | null>;

export function createSystemOneTurnRouter(options: { profileRouter: ProfileRouter }): TurnRouter {
  return (input) =>
    options.profileRouter({ ...input, explicitEffort: input.thinkingOptionId === "max" });
}
