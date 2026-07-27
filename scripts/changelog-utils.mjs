// One definition of how CHANGELOG.md is structured. Consumed by the GitHub release
// notes sync and by the F-Droid changelog sync, which need the same section bodies
// rendered two different ways.
const headingPattern = /^##\s+\[?([^\]\s]+)\]?\s*-\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*$/;
const sectionHeadingPattern = /^###\s+(.+?)\s*$/;
const bulletPattern = /^\s*[-*]\s+(.+?)\s*$/;
const blockquotePattern = /^\s*>\s?(.*)$/;

// Returns entries newest-first, matching the order they appear in the file.
export function parseChangelogEntries(changelogText) {
  const lines = changelogText.split(/\r?\n/);
  const headings = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(headingPattern);
    if (!match) {
      continue;
    }

    headings.push({
      version: match[1],
      date: match[2],
      headingLineIndex: index,
    });
  }

  if (headings.length === 0) {
    throw new Error(
      "No release headings found in CHANGELOG.md. Expected headings like `## 0.1.14 - 2026-02-19`.",
    );
  }

  return headings.map((heading, index) => {
    const nextHeading = headings[index + 1];
    const bodyStart = heading.headingLineIndex + 1;
    const bodyEnd = nextHeading ? nextHeading.headingLineIndex : lines.length;

    const bodyLines = lines.slice(bodyStart, bodyEnd);
    while (bodyLines.length > 0 && bodyLines[0].trim() === "") {
      bodyLines.shift();
    }
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === "") {
      bodyLines.pop();
    }

    return Object.assign({}, heading, { bodyLines });
  });
}

// Turns `[label](url)` into `label` and drops the trailing PR/attribution
// parenthetical, which is pure noise in a store changelog with a 500 char budget.
export function stripChangelogMarkup(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s*\((?:[^()]*(?:#\d+|by @)[^()]*)\)\s*$/, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// Collapses one blockquote into plain text, keeping paragraph breaks as newlines.
// `> **Important update notice**` + `>` + `> body` becomes a heading line and a
// body line, which is how it should read in a plain-text store changelog.
function formatQuotedNote(quotedLines) {
  const paragraphs = [];
  let current = [];

  for (const line of quotedLines) {
    if (line.trim() === "") {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      continue;
    }
    current.push(line);
  }

  if (current.length > 0) {
    paragraphs.push(current.join(" "));
  }

  return paragraphs
    .map((paragraph) => stripChangelogMarkup(paragraph))
    .filter((paragraph) => paragraph.length > 0)
    .join("\n");
}

// Splits an entry body into blockquoted notes and `### Heading` sections of
// plain-text bullets. Bullets before any section heading land in a leading
// untitled section.
//
// Notes are parsed separately rather than dropped because releases use
// blockquotes for action-required notices — 0.1.109's "you must reinstall
// manually" warning is the canonical example, and it matters more than any
// bullet in that entry. Anything that is neither a note, a heading, nor a bullet
// is still ignored.
export function parseChangelogBody(bodyLines) {
  const notes = [];
  const sections = [];
  let current = { bullets: [], title: null };
  let quotedLines = null;

  const flushQuote = () => {
    if (quotedLines === null) {
      return;
    }
    const note = formatQuotedNote(quotedLines);
    if (note.length > 0) {
      notes.push(note);
    }
    quotedLines = null;
  };

  for (const line of bodyLines) {
    const quoteMatch = line.match(blockquotePattern);
    if (quoteMatch) {
      if (quotedLines === null) {
        quotedLines = [];
      }
      quotedLines.push(quoteMatch[1]);
      continue;
    }

    // A blank line inside a `>` run would already have matched above, so any
    // non-quote line ends the current note.
    flushQuote();

    const sectionMatch = line.match(sectionHeadingPattern);
    if (sectionMatch) {
      if (current.bullets.length > 0) {
        sections.push(current);
      }
      current = { bullets: [], title: stripChangelogMarkup(sectionMatch[1]) };
      continue;
    }

    const bulletMatch = line.match(bulletPattern);
    if (!bulletMatch) {
      continue;
    }

    const bullet = stripChangelogMarkup(bulletMatch[1]);
    if (bullet.length > 0) {
      current.bullets.push(bullet);
    }
  }

  flushQuote();

  if (current.bullets.length > 0) {
    sections.push(current);
  }

  return { notes, sections };
}
