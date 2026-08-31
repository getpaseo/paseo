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
          The control plane
          <br />
          for coding agents
        </>
      }
      subtitle={
        <>
          Run any coding agent from anywhere.
          <br />
          Self-hosted, multi-provider, open source
        </>
      }
    />
  );
}
