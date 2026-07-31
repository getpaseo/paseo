import { describe, expect, it } from "vitest";
import { withPreviewCsp } from "@/file-pane/html-preview-csp";

const POLICY_MARKER = "content-security-policy";

function policyIndex(html: string): number {
  return html.toLowerCase().indexOf(POLICY_MARKER);
}

/**
 * The policy only governs what the parser has not reached yet, and only applies at
 * all while the parser is still building `<head>`. Both properties reduce to one
 * assertion: the policy is the document's first element, ahead of every construct
 * that could execute, fetch, or navigate.
 */
function expectPolicyFirst(source: string): string {
  const output = withPreviewCsp(source);
  expect(output.toLowerCase().startsWith("<!doctype html><meta http-equiv=")).toBe(true);
  const at = policyIndex(output);
  expect(at).toBeGreaterThan(-1);
  for (const tag of [
    "<script",
    "<style",
    "<link",
    "<img",
    "<iframe",
    "<object",
    "<body",
    "<html",
    '<meta http-equiv="refresh',
  ]) {
    const tagAt = output.toLowerCase().indexOf(tag);
    if (tagAt > -1) expect(at).toBeLessThan(tagAt);
  }
  return output;
}

describe("withPreviewCsp", () => {
  it("puts the policy first for ordinary documents", () => {
    expectPolicyFirst("<!doctype html><html><head><title>P</title></head><body></body></html>");
    expectPolicyFirst("<html><body><h1>Plan</h1></body></html>");
    expectPolicyFirst("<h1>Plan</h1>");
  });

  // Every shape below defeated an earlier implementation that tried to find the
  // document's own doctype and insert after it. Supplying the prologue instead
  // makes them all the same case.
  it("puts the policy first for documents that declare markup before <head>", () => {
    expectPolicyFirst(
      '<!doctype html><script>location.href="https://evil.example/"</script><html><head></head></html>',
    );
    expectPolicyFirst(
      '<!doctype html><link rel="stylesheet" href="https://evil.example/x.css"><html></html>',
    );
    expectPolicyFirst(
      '<!doctype html><meta http-equiv="refresh" content="0;url=https://evil.example/"><html></html>',
    );
  });

  it("puts the policy first for a bogus doctype that opens a quote", () => {
    expectPolicyFirst('<!doctype html "><script>window.evil=1</script>"<html></html>');
    expectPolicyFirst("<!doctype html '><img src=\"https://evil.example/p.png\">'<html></html>");
  });

  it("puts the policy first behind HTML space the parser ignores", () => {
    expectPolicyFirst("\n\t <!doctype html><html><head></head></html>");
  });

  // JS `\s` matches these; the HTML tokenizer's initial insertion mode does not, so
  // an implementation that skipped them landed the policy inside <body>, where a
  // meta http-equiv CSP has no effect.
  it("puts the policy first behind whitespace HTML does not ignore", () => {
    for (const space of [" ", " ", " ", "　", "​"]) {
      expectPolicyFirst(`${space}<!doctype html><script>fetch("https://evil.example/")</script>`);
    }
  });

  it("puts the policy first for every comment ending the tokenizer accepts", () => {
    for (const comment of [
      "<!-- generated -->",
      "<!-- generated --!>",
      "<!-->",
      "<!--->",
      "<!-- never closed",
      "<!--".repeat(8),
    ]) {
      expectPolicyFirst(`${comment}<!doctype html><script>window.evil=1</script>`);
    }
  });

  it("puts the policy first for bogus-comment tokens", () => {
    for (const prefix of [
      '<?xml version="1.0" encoding="utf-8"?>',
      "<!foo>",
      "<![CDATA[x]]>",
      '<?xml version="1.0" <script>window.evil=1</script>',
    ]) {
      expectPolicyFirst(`${prefix}<!doctype html><html></html>`);
    }
  });

  // No scanning means no input-dependent work at all, but the shapes that once took
  // seconds stay in the suite so a future rewrite can't quietly reintroduce it.
  it("does not scan the document, so pathological input stays instant", () => {
    for (const source of [
      "<!--x-->".repeat(5000) + "<html></html>",
      "<!--".repeat(5000),
      `<!--${"x".repeat(50000)}`,
      "<!doctype html " + '"'.repeat(5000) + "><html></html>",
    ]) {
      const startedAt = Date.now();
      expectPolicyFirst(source);
      expect(Date.now() - startedAt).toBeLessThan(100);
    }
  });

  it("keeps the document in standards mode", () => {
    // Our doctype leads, so the parser never falls into quirks mode. The file's own
    // doctype survives in the output as a token the parser ignores.
    const output = withPreviewCsp("<!doctype html><html><head></head></html>");
    expect(output.toLowerCase().indexOf("<!doctype")).toBe(0);
    expect(output.toLowerCase().split("<!doctype").length - 1).toBe(2);
  });

  it("drops a leading BOM rather than stranding it mid-document", () => {
    const output = withPreviewCsp("﻿<!doctype html><h1>Plan</h1>");
    expect(output.includes("﻿")).toBe(false);
    expect(output).toContain("<h1>Plan</h1>");
  });

  it("refuses egress and remote subresources but keeps inline scripts and styles", () => {
    const policy = withPreviewCsp("<h1>Plan</h1>");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("script-src 'unsafe-inline'");
    expect(policy).toContain("style-src 'unsafe-inline'");
    expect(policy).not.toMatch(/script-src[^;]*https:/);
    expect(policy).not.toMatch(/img-src[^;]*https:/);
    expect(policy).not.toMatch(/connect-src[^;]*https:/);
  });

  it("keeps the original markup intact", () => {
    const source = "<!doctype html><html><head></head><body><h1>Visual plan</h1></body></html>";
    expect(withPreviewCsp(source)).toContain(source);
  });
});
