import { createFileRoute } from "@tanstack/react-router";
import ReactMarkdown, { type Components } from "react-markdown";
import changelogMarkdown from "../../../../CHANGELOG.md?raw";
import { SiteShell } from "~/components/site-shell";
import { pageMeta } from "~/meta";

interface ChangelogRelease {
  version: string;
  date: string;
  markdown: string;
}

interface ChangelogReleaseGroup {
  version: string;
  releases: ChangelogRelease[];
}

const releaseHeadingPattern = /^## (.+?) - (\d{4}-\d{2}-\d{2})$/;
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

function minorVersion(version: string): string {
  return version.split(".").slice(0, 2).join(".");
}

function groupChangelogReleases(releases: ChangelogRelease[]): ChangelogReleaseGroup[] {
  const groups: ChangelogReleaseGroup[] = [];

  for (const release of releases) {
    const version = minorVersion(release.version);
    const currentGroup = groups.at(-1);
    if (currentGroup?.version === version) {
      currentGroup.releases.push(release);
    } else {
      groups.push({ version, releases: [release] });
    }
  }

  return groups;
}

const changelogReleaseGroups = groupChangelogReleases(changelogReleases);

function HeadingAnchor({ version }: { version: string }) {
  const anchor = `release-${version}`;

  return (
    <a
      href={`#${anchor}`}
      className="changelog-heading-anchor"
      aria-label={`Link to Paseo ${version}`}
    >
      <span aria-hidden="true">#</span>
    </a>
  );
}

function PatchRelease({ release }: { release: ChangelogRelease }) {
  const anchor = `release-${release.version}`;

  return (
    <section className="changelog-patch">
      <div id={anchor} className="changelog-patch-heading">
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
  const anchor = `release-${group.version}`;

  return (
    <article className="changelog-release">
      <div id={anchor} className="changelog-release-heading">
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
