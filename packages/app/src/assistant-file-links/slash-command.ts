// A leading-slash token in agent output (e.g. `/autoplan`) is ambiguous: it
// looks like an absolute path but is often a slash command / skill the agent is
// referring to. We extract a *candidate* name here; whether it is actually a
// command is decided by membership in the per-agent command list (see the
// `code_inline` rule in components/message.tsx), so this stays deliberately
// permissive and only rejects tokens that can't be a single command name —
// multi-segment paths (`/foo/bar`) and filenames (`/foo.ts`).
const SLASH_COMMAND_TOKEN = /^\/([A-Za-z0-9][A-Za-z0-9:_-]*)$/;

export function parseSlashCommandToken(value: string): string | null {
  const match = SLASH_COMMAND_TOKEN.exec(value.trim());
  return match ? match[1] : null;
}

// Append a slash-command token to the current composer draft, inserting a
// single separating space when the existing text doesn't already end in
// whitespace, and leaving a trailing space so the user can keep typing args.
export function appendSlashCommandToken(input: { text: string; token: string }): string {
  const { text, token } = input;
  const needsSeparator = text.length > 0 && !/\s$/.test(text);
  return `${text}${needsSeparator ? " " : ""}${token} `;
}
