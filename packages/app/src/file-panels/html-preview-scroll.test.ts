import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  allowPreviewScrollBridge,
  PREVIEW_SCROLL_SCRIPT,
  PREVIEW_SCROLL_SCRIPT_BODY,
  PREVIEW_SCROLL_SCRIPT_HASH,
  withPreviewScrollBridge,
} from "./html-preview-scroll";

function sha256(value: string): string {
  return `sha256-${createHash("sha256").update(value, "utf8").digest("base64")}`;
}

describe("preview scroll bridge", () => {
  // The hash is what lets the bridge run inside a file's own policy. If it drifts the
  // script is silently blocked and the preview starts at the top again, so the two are
  // checked against each other rather than trusted.
  it("allows exactly the script it appends", () => {
    expect(sha256(PREVIEW_SCROLL_SCRIPT_BODY)).toBe(PREVIEW_SCROLL_SCRIPT_HASH);
  });

  it("appends the bridge after the document", () => {
    const document = "<p>Plan</p>";

    const patched = withPreviewScrollBridge(document);

    expect(patched.startsWith(document)).toBe(true);
    expect(patched.endsWith(PREVIEW_SCROLL_SCRIPT)).toBe(true);
  });

  it("adds its hash to a policy that lists script sources", () => {
    const document =
      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'sha256-abc='\">";

    const patched = allowPreviewScrollBridge(document);

    expect(patched).toContain(`script-src 'sha256-abc=' '${PREVIEW_SCROLL_SCRIPT_HASH}'`);
    expect(patched).toContain("default-src 'none'");
  });

  it("leaves a policy that already allows inline scripts alone", () => {
    const document =
      '<meta http-equiv="Content-Security-Policy" content="script-src \'unsafe-inline\'">';

    // Adding a hash to this directive would make the browser ignore `'unsafe-inline'`
    // and block the file's own scripts.
    expect(allowPreviewScrollBridge(document)).toBe(document);
  });

  it("adds a script-src directive when the policy only has default-src", () => {
    const document =
      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">";

    expect(allowPreviewScrollBridge(document)).toContain(
      `script-src '${PREVIEW_SCROLL_SCRIPT_HASH}'`,
    );
  });

  it("leaves a document without a policy untouched apart from the bridge", () => {
    const document = "<!doctype html><h1>Plan</h1>";

    expect(withPreviewScrollBridge(document)).toBe(document + PREVIEW_SCROLL_SCRIPT);
  });
});
