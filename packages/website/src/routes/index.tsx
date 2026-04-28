import { createFileRoute } from "@tanstack/react-router";
import { LandingPage } from "~/components/landing-page";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: pageMeta(
      "Hubcode – The self-hosted control plane for your coding agents",
      "Chat, kanban, voice and shared sessions for Claude Code, Codex, OpenCode, Copilot, Pi and your CLI agents. Pair with teammates on a live agent. Self-hosted, open source.",
    ),
  }),
  component: Home,
});

function Home() {
  return (
    <LandingPage
      title={
        <>
          One control plane
          <br />
          for every coding agent
        </>
      }
      subtitle="Chat, kanban, voice and live shared sessions for Claude Code, Codex, OpenCode, Copilot, Pi and any CLI agent. Self-hosted. Pair with a teammate on a live agent run, or run the curated Hubtool agent on a single subscription."
    />
  );
}
