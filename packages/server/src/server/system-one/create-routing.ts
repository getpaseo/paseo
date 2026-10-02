import type { AgentRoutingNotice } from "../messages.js";
import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import type { ProfileRouter } from "./profile-routing.js";

export interface CreateRouteInput {
  requestedProvider: string;
  requestedModel: string | undefined;
  requestedThinking: string | undefined;
  prompt: AgentPromptInput | string;
  cwd: string;
  isAgentScoped: boolean;
}
export interface CreateRoute {
  provider: string;
  model?: string;
  thinkingOptionId?: string;
  reason?: string;
  routingNotice?: AgentRoutingNotice;
}
export type CreateRouter = (input: CreateRouteInput) => Promise<CreateRoute | null>;

export function createSystemOneCreateRouter(options: {
  profileRouter: ProfileRouter;
}): CreateRouter {
  return async (input) => {
    const route = await options.profileRouter({
      provider: input.requestedProvider,
      model: input.requestedModel,
      thinkingOptionId: input.requestedThinking,
      cwd: input.cwd,
      prompt: input.prompt,
      explicitEffort: !input.isAgentScoped && input.requestedThinking === "max",
    });
    return route
      ? {
          provider: route.profile.provider,
          model: route.model,
          thinkingOptionId: route.profile.thinkingOptionId,
          reason: route.reason,
          routingNotice: {
            fromProfile: input.requestedProvider,
            toProfile: route.profile.provider,
            fromModel: input.requestedModel ?? null,
            model: route.model,
            fromEffort: input.requestedThinking ?? null,
            effort: route.profile.thinkingOptionId ?? null,
            resetsAt: route.resetsAt,
            status: "selected",
            reason: route.reason,
          },
        }
      : null;
  };
}
