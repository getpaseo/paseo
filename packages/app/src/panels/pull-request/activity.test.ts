import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { pullRequestDemand, shouldDiscoverPullRequest } from "./activity";

it("stops retained PR summary and timeline demand, then catches up once on reopen", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const calls = { status: 0, timeline: 0 };
  const options = (kind: "status" | "timeline", active: boolean, consumer: "rail" | "content") => ({
    queryKey: [kind],
    queryFn: async () => ++calls[kind],
    enabled:
      kind === "status"
        ? pullRequestDemand(active, consumer).enabled
        : pullRequestDemand(active, consumer).timelineEnabled,
  });
  const status = new QueryObserver(client, options("status", true, "content"));
  const timeline = new QueryObserver(client, options("timeline", true, "content"));
  const unsubscribe = [status.subscribe(() => {}), timeline.subscribe(() => {})];
  await Promise.all([status.refetch(), timeline.refetch()]);
  expect(calls).toEqual({ status: 1, timeline: 1 });
  status.setOptions(options("status", false, "content"));
  timeline.setOptions(options("timeline", false, "content"));
  await client.invalidateQueries();
  expect(calls).toEqual({ status: 1, timeline: 1 });
  status.setOptions(options("status", true, "rail"));
  timeline.setOptions(options("timeline", true, "rail"));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(calls).toEqual({ status: 2, timeline: 1 });
  timeline.setOptions(options("timeline", true, "content"));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(calls).toEqual({ status: 2, timeline: 2 });
  unsubscribe.forEach((stop) => stop());
  client.clear();
});

it.each([
  [true, true, true, false, true],
  [true, true, false, true, true],
  [true, true, false, false, false],
  [false, true, true, true, false],
  [true, false, true, true, false],
])(
  "budgets discovery independently of tab existence",
  (workspaceActive, isGit, splitLayout, explorerActive, expected) => {
    expect(shouldDiscoverPullRequest({ workspaceActive, isGit, splitLayout, explorerActive })).toBe(
      expected,
    );
  },
);
