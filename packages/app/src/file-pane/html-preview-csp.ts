// A preview renders a self-contained document and nothing else. Inline styles and
// scripts run so a plan page keeps its layout and its diagrams; fetch, XHR,
// WebSocket, beacon, remote script, remote font, remote image, and form posts are
// all refused. Agent-written HTML is not trusted markup.
//
// What this does NOT stop: the document navigating itself. No CSP directive
// available in current browsers prevents it — `navigate-to` was dropped from CSP3
// and is unenforced, and `<meta http-equiv="refresh">` needs no script at all
// (both verified against the Chromium this app ships against). So a hostile page
// can still reach a server by navigating, carrying its own contents and the
// viewer's IP. The opaque origin is what bounds the damage: the frame has no
// storage, no parent access, and no way to read any file but itself, so it can
// leak what it already contained and nothing else. Native narrows it further in
// html-preview.tsx, because a WebView can refuse navigation outside CSP — see the
// caveat there on why that is a mitigation rather than a guarantee.
const POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join("; ");

const META = `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`;

// The policy must reach the parser before any markup the document declares, and it
// only counts if it lands in `<head>` — once the parser has moved on to `<body>`, a
// meta http-equiv CSP is ignored outright.
//
// Locating the document's own doctype to insert after it means reimplementing the
// tokenizer's initial insertion mode: its exact whitespace set (JS `\s` matches
// characters HTML does not, and one stray NBSP is enough to push the policy into
// the body where it stops applying), every comment ending including `--!>`, `<!-->`
// and `<!--->`, bogus-comment tokens like `<?xml …?>` and `<![CDATA[…]]>`, and the
// rule that a doctype closes at the first `>` in every state. Each of those rules
// cost a bug before it was right.
//
// So the prologue isn't found, it's supplied: our doctype, then the policy, then
// the file verbatim. The file's own doctype becomes a stray DOCTYPE token, which
// the parser ignores wherever it appears. Standards mode is guaranteed, the policy
// is always the first element and therefore always in the head, and no part of the
// document has to be parsed to place it.
const PROLOGUE = `<!doctype html>${META}`;

// Left where it is, a BOM would sit mid-document and render as a zero-width space.
const BOM = "\uFEFF";

export function withPreviewCsp(html: string): string {
  return PROLOGUE + (html.startsWith(BOM) ? html.slice(BOM.length) : html);
}
