import { createFileRoute } from "@tanstack/react-router";
import { LandingPage } from "~/components/landing-page";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/")({
  head: () =>
    pageMeta(
      "Paseo – Run Claude Code, Codex, Copilot, OpenCode from anywhere",
      "Self-hosted daemon for Claude Code, Codex, Copilot, OpenCode, and Pi. Agents run on your machine with your full dev environment. Connect from phone, desktop, or web.",
      "/",
    ),
  component: Home,
});

function Home() {
  return (
    <LandingPage
      title={
        <>
          Orchestrate coding agents
          <br />
          from your desk and your phone
        </>
      }
      subtitle="Run any coding agent from your phone, desktop, or terminal. Self-hosted, multi-provider, open source."
    />
  );
}
