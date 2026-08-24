import stripAnsi from "strip-ansi";

export interface LocalServiceUrlCandidate {
  url: string;
  protocol: "http:" | "https:";
  hostname: string;
  port: number;
}

const LOCAL_HOST_PATTERN = String.raw`(?:localhost|[a-z0-9.-]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])`;
const LOCAL_SERVICE_URL_PATTERN = new RegExp(
  String.raw`https?:\/\/${LOCAL_HOST_PATTERN}:(\d{1,5})(?:\/[^\s<>"']*)?`,
  "giu",
);

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[),.;\]}]+$/u, "");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized === "[::1]" || normalized === "::1") return true;
  if (!normalized.startsWith("127.")) return false;
  const octets = normalized.split(".").map(Number);
  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet <= 255);
}

function parseCandidate(raw: string, portText: string): LocalServiceUrlCandidate | null {
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  try {
    const parsed = new URL(trimTrailingPunctuation(raw));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!isLoopbackHostname(parsed.hostname)) return null;
    return {
      url: parsed.toString(),
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port,
    };
  } catch {
    return null;
  }
}

export function findLocalServiceUrls(output: string): LocalServiceUrlCandidate[] {
  const text = stripAnsi(output);
  const byUrl = new Map<string, LocalServiceUrlCandidate>();
  for (const match of text.matchAll(LOCAL_SERVICE_URL_PATTERN)) {
    const candidate = parseCandidate(match[0], match[1] ?? "");
    if (candidate) byUrl.set(candidate.url, candidate);
  }
  return [...byUrl.values()];
}

export class LocalServiceUrlStreamDetector {
  private buffer = "";
  private readonly lastUrlByPort = new Map<number, string>();

  constructor(private readonly maxBufferChars = 8_192) {}

  push(chunk: string): LocalServiceUrlCandidate[] {
    this.buffer = `${this.buffer}${chunk}`.slice(-this.maxBufferChars);
    return findLocalServiceUrls(this.buffer).filter((candidate) => {
      if (this.lastUrlByPort.get(candidate.port) === candidate.url) return false;
      this.lastUrlByPort.set(candidate.port, candidate.url);
      return true;
    });
  }

  clear(): void {
    this.buffer = "";
    this.lastUrlByPort.clear();
  }
}
