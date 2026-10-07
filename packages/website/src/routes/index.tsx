import { createFileRoute } from "@tanstack/react-router";
import { LandingPage } from "~/components/landing-page";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/")({
  head: () =>
    pageMeta(
      "Paseo – Run Claude Code, Codex, Copilot, OpenCode from anywhere",
      "Open source app for Claude Code, Codex, OpenCode, Pi, and 30+ more coding agents. Run many agents in parallel on your machines. Editor, terminals, diffs, pull requests, and a browser in one window. One download on desktop. The full app on iOS and Android.",
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
          Run many coding agents at once, on your machines.
          <br />
          Desktop and mobile. Open source.
        </>
      }
    />
  );
}
