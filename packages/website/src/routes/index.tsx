import { createFileRoute } from "@tanstack/react-router";
import { LandingPage } from "~/components/landing-page";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: pageMeta(
      "Paseo – Run Claude Code, Codex, and OpenCode from everywhere",
      "A self-hosted daemon for Claude Code, Codex, and OpenCode. Agents run on your machine with your full dev environment. Connect from phone, desktop, or web.",
    ),
  }),
  component: Home,
});

function Home() {
  return (
    <LandingPage
      title={<>Orchestrate coding agents<br />from your desk and your phone</>}
      subtitle="Run any coding agent from your phone, desktop, or terminal. Self-hosted, multi-provider, open source."
    />
  );
}
