import { createFileRoute } from "@tanstack/react-router";
import { LandingPage } from "~/components/landing-page";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: pageMeta(
      "Paseo – Run Claude Code, Codex, and OpenCode from everywhere",
      "A self-hosted daemon for Claude Code, Codex, and OpenCode. Agents run on your machine with your full dev environment. Connect from the web or the macOS desktop app.",
    ),
  }),
  component: Home,
});

function Home() {
  return (
    <LandingPage
      title={
        <>
          Orchestrate coding agents
          <br />
          from your desk or your browser
        </>
      }
      subtitle="Run any coding agent from the web, the macOS desktop app, or the terminal. Self-hosted, multi-provider, open source."
    />
  );
}
