/** Shared allowlist for links passed to an OS opener or a workspace browser. */
export function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Only absolute HTTP(S) URLs are supported.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only absolute HTTP(S) URLs are supported.");
  }
}
