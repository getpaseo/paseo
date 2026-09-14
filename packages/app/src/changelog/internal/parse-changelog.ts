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
