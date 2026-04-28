import { createFileRoute } from "@tanstack/react-router";
import { LandingPage } from "~/components/landing-page";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/codex")({
  head: () => ({
    meta: pageMeta(
      "Codex Mobile App – Run Codex from anywhere | Hubcode",
      "Run OpenAI Codex from your phone. Kick off agents, monitor progress, and ship code without being at your desk. Self-hosted, your code never leaves your machine.",
    ),
  }),
  component: CodexPage,
});

function CodexPage() {
  return (
    <LandingPage
      title="Run Codex from anywhere"
      subtitle="Kick off Codex agents on your machine from your phone. Check in on the train, review on the couch, merge from the park."
    />
  );
}
