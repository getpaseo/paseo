const ANSI_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");

interface PairingInstructions {
  url: string;
  qr: string | null;
  connectionUri?: string | null;
  columns?: number;
}

function visibleWidth(value: string): number {
  return Math.max(
    ...value
      .replace(ANSI_PATTERN, "")
      .split("\n")
      .map((line) => line.length),
  );
}

function formatQr(qr: string | null, columns: number | undefined): string {
  if (!qr) {
    return "QR code is unavailable. Use the pairing link below.";
  }

  if (columns === undefined) {
    return "QR code not shown because terminal width could not be detected.";
  }

  const width = visibleWidth(qr);
  if (columns <= width) {
    return `QR code not shown. Resize the terminal to at least ${width + 1} columns, then run this command again.`;
  }

  return qr;
}

function redactConnectionUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.searchParams.has("password")) {
      parsed.searchParams.set("password", "[redacted]");
    }
    return parsed.toString();
  } catch {
    return "Invalid connection URI";
  }
}

export function formatPairingInstructions({
  url,
  qr,
  columns,
  connectionUri,
}: PairingInstructions): string {
  return `\nScan to pair:\n${formatQr(qr, columns)}\n\nPairing link:\n${url}${connectionUri ? `\n\nConnection URI:\n${redactConnectionUri(connectionUri)}` : ""}\n\nTreat this pairing link like a password. Anyone with it can access this daemon.\n`;
}
