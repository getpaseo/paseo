const GIT_PATH_ESCAPE_BYTES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

// core.quotepath=false still quotes control characters, double quotes and backslashes.
export function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;

  const encoded = value.slice(1, -1);
  const parts: Buffer[] = [];
  let offset = 0;
  for (const match of encoded.matchAll(/\\([0-7]{1,3}|[abfnrtv"\\])/g)) {
    parts.push(Buffer.from(encoded.slice(offset, match.index)));
    const escape = match[1];
    let byte: number;
    if (/^[0-7]/.test(escape)) {
      byte = Number.parseInt(escape, 8);
    } else {
      byte = GIT_PATH_ESCAPE_BYTES[escape];
    }
    parts.push(Buffer.from([byte]));
    offset = match.index + match[0].length;
  }
  parts.push(Buffer.from(encoded.slice(offset)));
  return Buffer.concat(parts).toString("utf8");
}
