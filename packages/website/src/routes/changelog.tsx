import { createFileRoute } from "@tanstack/react-router";
import ReactMarkdown, { type Components } from "react-markdown";
import {
  changelogReleaseGroups,
  releaseAnchor,
  type ChangelogRelease,
  type ChangelogReleaseGroup,
} from "~/changelog";
import { SiteShell } from "~/components/site-shell";
import { pageMeta } from "~/meta";

const patchMarkdownComponents: Components = { h3: "h4" };

export const Route = createFileRoute("/changelog")({
  head: () =>
    pageMeta(
      "Changelog - Paseo",
      "Product updates, bug fixes, and improvements shipped in each Paseo release. Track new agent providers, mobile features, and daemon changes over time.",
      "/changelog",
    ),
  component: Changelog,
});

function formatDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function HeadingAnchor({ version }: { version: string }) {
  return (
    <a
      href={`#${releaseAnchor(version)}`}
      className="changelog-heading-anchor"
      aria-label={`Link to Paseo ${version}`}
    >
      <span aria-hidden="true">#</span>
    </a>
  );
}

function PatchRelease({ release }: { release: ChangelogRelease }) {
  return (
    <section className="changelog-patch">
      <div id={releaseAnchor(release.version)} className="changelog-patch-heading">
        <HeadingAnchor version={release.version} />
        <h3 className="changelog-patch-title">{release.version}</h3>
        <time dateTime={release.date} className="changelog-release-date">
          {formatDate(release.date)}
        </time>
      </div>
      <div className="changelog-release-notes">
        <ReactMarkdown components={patchMarkdownComponents}>{release.markdown}</ReactMarkdown>
      </div>
    </section>
  );
}

function Release({ group }: { group: ChangelogReleaseGroup }) {
  return (
    <article className="changelog-release">
      <div id={releaseAnchor(group.version)} className="changelog-release-heading">
        <HeadingAnchor version={group.version} />
        <h2 className="changelog-release-title">
          Paseo <span>{group.version}</span>
        </h2>
      </div>
      <div className="changelog-patches">
        {group.releases.map((release) => (
          <PatchRelease key={release.version} release={release} />
        ))}
      </div>
    </article>
  );
}

function Changelog() {
  return (
    <SiteShell width="default">
      <div className="max-w-2xl">
        <h1 className="mb-12 text-3xl font-medium tracking-tight">Changelog</h1>
        {changelogReleaseGroups.map((group) => (
          <Release key={group.version} group={group} />
        ))}
      </div>
    </SiteShell>
  );
}
