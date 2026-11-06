/**
 * Structural parser for a CHANGELOG.md document.
 *
 * The document is authored in the repository, fetched at runtime, and rewritten
 * on every release, so this parser commits to exactly two facts: a `##` heading
 * starts a release and a `###` heading starts a section inside it. Everything
 * else — prose, callouts, block quotes, fenced code, images, video and embed
 * HTML, tables, nested lists — is carried through verbatim and handed to the
 * Markdown renderer. A new block kind in the changelog therefore needs no
 * change here.
 *
 * Section titles are read, never matched: renaming "Improved" or adding a
 * section is a content change, not a code change.
 *
 * The one way a line scan can be fooled is a fenced block whose contents look
 * like a heading, so fences are tracked.
 */

export interface ChangelogSection {
  /** The `###` heading text, or null for content that precedes the first one. */
  title: string | null;
  /** Verbatim markdown under the heading. */
  body: string;
}

export interface ChangelogRelease {
  /** Version as authored, stripped of link, bracket and `v` decoration. */
  version: string;
  /** The heading tail after the version. Empty when the heading carried none. */
  date: string;
  /** Sections in document order; the untitled lead section comes first. */
  sections: ChangelogSection[];
}

// `##` / `###` must be followed by whitespace, which is what keeps each pattern
// from matching one level deeper.
const RELEASE_HEADING = /^ {0,3}##(?:[ \t]+(.*?))?[ \t]*$/;
const SECTION_HEADING = /^ {0,3}###(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;
const ATX_CLOSING = /[ \t]+#+[ \t]*$/;
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const DASH_SEPARATED_DATE = /^(.*?)\s+[-–—]\s+(.+)$/;
const PARENTHESIZED_DATE = /^(.*?)\s*\((.+)\)$/;
const BRACKETED_VERSION = /^\[(.*)\]$/;
const LEADING_V = /^v(?=\d)/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface SectionDraft {
  title: string | null;
  lines: string[];
}

interface ReleaseDraft {
  version: string;
  date: string;
  sections: SectionDraft[];
}

export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ReleaseDraft[] = [];
  let fence: string | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const fenceEdge = line.match(FENCE_OPEN)?.[1];
    if (fenceEdge) {
      if (!fence) {
        fence = fenceEdge;
      } else if (fenceEdge[0] === fence[0] && fenceEdge.length >= fence.length) {
        fence = null;
      }
    }

    if (!fence) {
      const releaseHeading = line.match(RELEASE_HEADING);
      if (releaseHeading) {
        releases.push({
          ...splitReleaseHeading(releaseHeading[1] ?? ""),
          sections: [{ title: null, lines: [] }],
        });
        continue;
      }

      const sectionHeading = line.match(SECTION_HEADING);
      if (sectionHeading && releases.length > 0) {
        releases[releases.length - 1].sections.push({
          title: (sectionHeading[1] ?? "").replace(ATX_CLOSING, "").trim() || null,
          lines: [],
        });
        continue;
      }
    }

    const release = releases.at(-1);
    if (release) release.sections[release.sections.length - 1].lines.push(line);
  }

  return releases.map(materializeRelease);
}

function materializeRelease(draft: ReleaseDraft): ChangelogRelease {
  const sections = draft.sections
    .map((section) => ({ title: section.title, body: trimBlankLines(section.lines) }))
    // A heading with an empty body still names something; an empty lead section
    // is just the gap between the release heading and the first section.
    .filter((section) => section.title !== null || section.body.length > 0);
  return { version: draft.version, date: draft.date, sections };
}

function trimBlankLines(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim().length === 0) start += 1;
  while (end > start && lines[end - 1].trim().length === 0) end -= 1;
  return lines.slice(start, end).join("\n");
}

function splitReleaseHeading(heading: string): { version: string; date: string } {
  const plain = heading.replace(ATX_CLOSING, "").replace(MARKDOWN_LINK, "$1").trim();

  const dashed = plain.match(DASH_SEPARATED_DATE);
  if (dashed) return { version: normalizeVersion(dashed[1]), date: dashed[2].trim() };

  const parenthesized = plain.match(PARENTHESIZED_DATE);
  if (parenthesized) {
    return { version: normalizeVersion(parenthesized[1]), date: parenthesized[2].trim() };
  }

  return { version: normalizeVersion(plain), date: "" };
}

function normalizeVersion(raw: string): string {
  const unbracketed = raw.trim().replace(BRACKETED_VERSION, "$1").trim();
  return unbracketed.replace(LEADING_V, "");
}

/**
 * The releases the installed app has reached. CHANGELOG.md on main lists betas
 * ahead of the latest stable, and a stable install should not read notes for a
 * version it does not have. A heading that is not a version is kept, and so is
 * everything when the installed version is unknown.
 */
export function releasesUpTo(
  releases: ChangelogRelease[],
  installedVersion: string | null,
): ChangelogRelease[] {
  const installed = installedVersion ? parseVersion(installedVersion) : null;
  if (!installed) return releases;
  return releases.filter((release) => {
    const version = parseVersion(release.version);
    return !version || compareVersions(version, installed) <= 0;
  });
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const NUMERIC_IDENTIFIER = /^\d+$/;

interface ParsedVersion {
  core: number[];
  prerelease: string[];
}

function parseVersion(raw: string): ParsedVersion | null {
  const match = raw.trim().match(SEMVER);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

/** Semver precedence: a prerelease sorts before its stable core. */
function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (let index = 0; index < 3; index += 1) {
    const diff = a.core[index] - b.core[index];
    if (diff !== 0) return diff;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return b.prerelease.length - a.prerelease.length;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumeric = NUMERIC_IDENTIFIER.test(left);
    const rightNumeric = NUMERIC_IDENTIFIER.test(right);
    if (leftNumeric && rightNumeric) return Number(left) - Number(right);
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * ISO dates become the reader's locale; anything else the author wrote is shown
 * as authored rather than guessed at.
 */
export function formatChangelogDate(date: string): string {
  if (!ISO_DATE.test(date)) return date;
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(value.getTime())) return date;
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(value);
}
