import { createFileRoute } from "@tanstack/react-router";
import ReactMarkdown from "react-markdown";
import changelogMarkdown from "../../../../CHANGELOG.md?raw";
import { SiteShell } from "~/components/site-shell";
import { pageMeta } from "~/meta";

interface ChangelogRelease {
  version: string;
  date: string;
  markdown: string;
}

const releaseHeadingPattern = /^## (.+?) - (\d{4}-\d{2}-\d{2})$/;

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

function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  const versions = new Set<string>();
  let currentRelease: ChangelogRelease | null = null;

  for (const line of markdown.split("\n")) {
    const heading = line.match(releaseHeadingPattern);
    if (heading) {
      const version = heading[1];
      if (versions.has(version)) {
        throw new Error(`Duplicate changelog version: ${version}`);
      }
      versions.add(version);

      if (currentRelease) releases.push(currentRelease);
      currentRelease = {
        version,
        date: heading[2],
        markdown: "",
      };
      continue;
    }

    if (currentRelease) currentRelease.markdown += `${line}\n`;
  }

  if (currentRelease) releases.push(currentRelease);
  return releases;
}

const changelogReleases = parseChangelog(changelogMarkdown);

function Release({ release }: { release: ChangelogRelease }) {
  const anchor = `release-${release.version}`;

  return (
    <article className="changelog-release">
      <time dateTime={release.date} className="changelog-release-date">
        {formatDate(release.date)}
      </time>
      <div id={anchor} className="changelog-release-heading">
        <a
          href={`#${anchor}`}
          className="changelog-heading-anchor"
          aria-label={`Link to Paseo ${release.version}`}
        >
          <span aria-hidden="true">#</span>
        </a>
        <h2 className="changelog-release-title">
          Paseo <span>{release.version}</span>
        </h2>
      </div>
      <div className="changelog-release-notes">
        <ReactMarkdown>{release.markdown}</ReactMarkdown>
      </div>
    </article>
  );
}

function Changelog() {
  return (
    <SiteShell width="default">
      <div className="max-w-2xl">
        <h1 className="mb-12 text-3xl font-medium tracking-tight">Changelog</h1>
        {changelogReleases.map((release) => (
          <Release key={release.version} release={release} />
        ))}
      </div>
    </SiteShell>
  );
}
