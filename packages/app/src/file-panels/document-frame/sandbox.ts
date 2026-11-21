/**
 * Chromium refuses to run its PDF viewer in a sandboxed frame, regardless of tokens.
 * The viewer is a browser component, not page script. The host sets the blob's type from
 * the daemon's MIME type, so HTML bytes labeled PDF fail to parse in the viewer rather
 * than executing. HTML and every other media type retain the full sandbox.
 */
export function documentFrameSandbox(mediaType: string | null | undefined): string | null {
  return mediaType?.split(";")[0].trim().toLowerCase() === "application/pdf" ? null : "";
}
