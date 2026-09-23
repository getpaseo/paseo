import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "~/components/site-shell";
import { SponsorPaseoSection, SponsorSpotSection } from "~/components/sponsorship";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/sponsor")({
  head: () =>
    pageMeta(
      "Sponsor Paseo",
      "Paseo is built by one person with no investors. Sponsor the work on GitHub Sponsors, Open Collective or Buy Me a Coffee, or put your company's logo on the homepage.",
      "/sponsor",
    ),
  component: Sponsor,
});

function Sponsor() {
  return (
    <SiteShell width="default">
      <div className="space-y-24">
        <SponsorPaseoSection />
        <SponsorSpotSection />
      </div>
    </SiteShell>
  );
}
