import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HubLockup, PaseoHubLockup, PaseoHubMark, PaseoLockup, PaseoMark } from "./paseo-brand";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const BRAND_ROOT = path.join(REPO_ROOT, "assets/brand");
const WEBSITE_PUBLIC = path.join(REPO_ROOT, "packages/website/public");

function extractPathData(svg: string): string[] {
  return [...svg.matchAll(/\bd="([^"]+)"/g)].map((m) => m[1]);
}

describe("paseo brand assets", () => {
  it("renders canonical Paseo and Paseo Hub marks with currentColor", () => {
    const paseoHtml = renderToStaticMarkup(<PaseoMark className="h-6 w-6" />);
    const hubHtml = renderToStaticMarkup(<PaseoHubMark className="h-6 w-6" />);
    const canonicalPaseo = readFileSync(path.join(BRAND_ROOT, "marks/paseo-white.svg"), "utf8");
    const canonicalHub = readFileSync(path.join(BRAND_ROOT, "marks/paseo-hub-white.svg"), "utf8");

    expect(paseoHtml).toContain('viewBox="0 0 700 700"');
    expect(paseoHtml).toContain('stroke="currentColor"');
    expect(paseoHtml).toContain('stroke-width="50"');
    expect(extractPathData(paseoHtml)).toEqual(extractPathData(canonicalPaseo));

    expect(hubHtml).toContain('viewBox="0 0 700 700"');
    expect(hubHtml).toContain('stroke="currentColor"');
    expect(hubHtml).toContain('stroke-width="50"');
    expect(extractPathData(hubHtml)).toEqual(extractPathData(canonicalHub));
  });

  it("renders canonical Paseo, Paseo Hub, and Hub lockups at shared 144-unit height", () => {
    const cases = [
      { Component: PaseoLockup, file: "lockups/paseo-white.svg", width: 580 },
      { Component: PaseoHubLockup, file: "lockups/paseo-hub-white.svg", width: 842 },
      { Component: HubLockup, file: "lockups/hub-white.svg", width: 461 },
    ];

    for (const { Component, file, width } of cases) {
      const html = renderToStaticMarkup(<Component className="h-6 w-auto" />);
      const canonical = readFileSync(path.join(BRAND_ROOT, file), "utf8");

      expect(html).toContain(`viewBox="0 0 ${width} 144"`);
      expect(html).toContain(`width="${width}"`);
      expect(html).toContain('height="144"');
      expect(html).toContain('stroke="currentColor"');
      expect(html).toContain('fill="currentColor"');
      expect(extractPathData(html)).toEqual(extractPathData(canonical));
    }
  });

  it("tightens symbol-to-wordmark spacing for display-scale lockups while keeping canonical paths", () => {
    const html = renderToStaticMarkup(<PaseoHubLockup size="display" className="h-12 w-auto" />);
    const canonical = readFileSync(path.join(BRAND_ROOT, "lockups/paseo-hub-white.svg"), "utf8");

    expect(html).toContain('viewBox="0 0 798 144"');
    expect(html).toContain('width="798"');
    expect(html).toContain('transform="translate(-44 0)"');
    expect(extractPathData(html)).toEqual(extractPathData(canonical));
  });

  it("keeps public/logo.svg and public/favicon.svg aligned with assets/brand", () => {
    const canonicalPaseo = readFileSync(path.join(BRAND_ROOT, "marks/paseo-white.svg"), "utf8");
    const publicLogo = readFileSync(path.join(WEBSITE_PUBLIC, "logo.svg"), "utf8");
    const publicFavicon = readFileSync(path.join(WEBSITE_PUBLIC, "favicon.svg"), "utf8");

    expect(publicLogo).toBe(canonicalPaseo);
    expect(publicFavicon).toContain('<rect width="700" height="700" rx="156" fill="#000000"');
    expect(extractPathData(publicFavicon)).toEqual(extractPathData(canonicalPaseo));
  });

  it("ships a multi-size favicon.ico with 48, 32, and 16px entries", () => {
    const ico = readFileSync(path.join(WEBSITE_PUBLIC, "favicon.ico"));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    const sizes: number[] = [];
    for (let i = 0; i < count; i += 1) {
      sizes.push(ico[6 + i * 16] || 256);
    }
    expect(sizes).toEqual([48, 32, 16]);
  });
});
