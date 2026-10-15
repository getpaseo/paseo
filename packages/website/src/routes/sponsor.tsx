import { createFileRoute } from "@tanstack/react-router";
import { SiteShell } from "~/components/site-shell";
import { SponsorPaseoSection, SponsorSpotSection } from "~/components/sponsorship";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/sponsor")({
  head: () =>
    pageMeta(
      "Sponsor Paseo",
      "Paseo is an independent project used by tens of thousands of developers daily, built by one person with no investors. Sponsor the work on GitHub Sponsors, Open Collective or Buy Me a Coffee, or sponsor it as a company.",
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
