import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Checklist, ContextLength, PlanFirst, ReviewFlag } from "./client/controls";

export default function contribute(client: PluginClientContext) {
  client.addComposerItem({ id: "context-length", Component: ContextLength });
  client.addComposerItem({ id: "review-flag", Component: ReviewFlag });
  client.addComposerItem({ id: "plan-first", Component: PlanFirst });
  client.addComposerItem({ id: "checklist", Component: Checklist });
  return () => {};
}
