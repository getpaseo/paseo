/**
 * Structural parser for a CHANGELOG.md document.
 *
 * The document is authored in the repository, fetched at runtime, and rewritten
 * on every release, so this parser commits to exactly two facts: a `##` heading
 * starts a release and a `###` heading starts a section inside it. Whatever sits
 * between the release heading and its first section is the release's
 * highlights: the list a release now leads with, or the summary paragraphs and
 * notices older entries opened with. Everything
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
  /** The `###` heading text. Empty for a bare `###`. */
  title: string;
  /** Verbatim markdown under the heading. */
  body: string;
}

export interface ChangelogRelease {
  /** Version as authored, stripped of link, bracket and `v` decoration. */
  version: string;
  /** The heading tail after the version. Empty when the heading carried none. */
  date: string;
  /** Verbatim markdown before the first section. Empty when the release opens with one. */
  highlights: string;
  /** The `###` sections in document order. */
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
  title: string;
  lines: string[];
}

interface ReleaseDraft {
  version: string;
  date: string;
  highlights: string[];
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
          highlights: [],
          sections: [],
        });
        continue;
      }

      const sectionHeading = line.match(SECTION_HEADING);
      if (sectionHeading && releases.length > 0) {
        releases[releases.length - 1].sections.push({
          title: (sectionHeading[1] ?? "").replace(ATX_CLOSING, "").trim(),
          lines: [],
        });
        continue;
      }
    }

    const release = releases.at(-1);
    if (release) (release.sections.at(-1)?.lines ?? release.highlights).push(line);
  }

  return releases.map(materializeRelease);
}

function materializeRelease(draft: ReleaseDraft): ChangelogRelease {
  return {
    version: draft.version,
    date: draft.date,
    highlights: trimBlankLines(draft.highlights),
    sections: draft.sections.map((section) => ({
      title: section.title,
      body: trimBlankLines(section.lines),
    })),
  };
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
