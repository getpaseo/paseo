import { createFileRoute } from "@tanstack/react-router";
import { LandingPage } from "~/components/landing-page";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/claude-code")({
  head: () => ({
    meta: pageMeta(
      "Claude Code Mobile App – Ship from your phone | Hubcode",
      "Run Claude Code from your phone. Launch agents, check on progress, review diffs, and merge — all from your pocket. Self-hosted, your code stays on your machine.",
    ),
  }),
  component: ClaudeCodePage,
});

function ClaudeCodePage() {
  return (
    <LandingPage
      title="Ship with Claude Code from your phone"
      subtitle="Launch agents, check on progress, and merge from anywhere. Your Claude Code setup, your machine, your pocket."
    />
  );
}
