// Canonical Paseo and Paseo Hub brand marks and lockups, sourced directly from
// `assets/brand/` (see `assets/brand/README.md`).

import type * as React from "react";
import hubLockupSvg from "../../../../assets/brand/lockups/hub-white.svg?raw";
import paseoHubLockupSvg from "../../../../assets/brand/lockups/paseo-hub-white.svg?raw";
import paseoLockupSvg from "../../../../assets/brand/lockups/paseo-white.svg?raw";
import paseoHubMarkSvg from "../../../../assets/brand/marks/paseo-hub-white.svg?raw";
import paseoMarkSvg from "../../../../assets/brand/marks/paseo-white.svg?raw";

interface ParsedMark {
  width: number;
  height: number;
  viewBox: string;
  path: string;
  strokeWidth: number;
}

interface ParsedLockup extends ParsedMark {
  wordmarkPath: string;
}

function readAttr(tag: string, name: string, source: string): string {
  const match = tag.match(new RegExp(`${name}="([^"]+)"`));
  if (!match) {
    throw new Error(`Missing ${name} attribute in canonical brand SVG (${source})`);
  }
  return match[1];
}

function parseSvgHeader(svg: string, source: string) {
  const svgTag = svg.match(/<svg\b[^>]*>/)?.[0];
  if (!svgTag) {
    throw new Error(`Missing <svg> root in canonical brand SVG (${source})`);
  }
  const paths = [...svg.matchAll(/<path\b[^>]*\/?>/g)].map((m) => m[0]);
  return {
    width: Number(readAttr(svgTag, "width", source)),
    height: Number(readAttr(svgTag, "height", source)),
    viewBox: readAttr(svgTag, "viewBox", source),
    paths,
  };
}

function parseMark(svg: string, source: string): ParsedMark {
  const { width, height, viewBox, paths } = parseSvgHeader(svg, source);
  if (paths.length !== 1) {
    throw new Error(`Expected 1 path in brand mark SVG (${source}), found ${paths.length}`);
  }
  return {
    width,
    height,
    viewBox,
    path: readAttr(paths[0], "d", source),
    strokeWidth: Number(readAttr(paths[0], "stroke-width", source)),
  };
}

function parseLockup(svg: string, source: string): ParsedLockup {
  const { width, height, viewBox, paths } = parseSvgHeader(svg, source);
  if (paths.length !== 2) {
    throw new Error(`Expected 2 paths in brand lockup SVG (${source}), found ${paths.length}`);
  }
  return {
    width,
    height,
    viewBox,
    path: readAttr(paths[0], "d", source),
    strokeWidth: Number(readAttr(paths[0], "stroke-width", source)),
    wordmarkPath: readAttr(paths[1], "d", source),
  };
}

const PASEO_MARK = parseMark(paseoMarkSvg, "marks/paseo-white.svg");
const PASEO_HUB_MARK = parseMark(paseoHubMarkSvg, "marks/paseo-hub-white.svg");
const PASEO_LOCKUP = parseLockup(paseoLockupSvg, "lockups/paseo-white.svg");
const PASEO_HUB_LOCKUP = parseLockup(paseoHubLockupSvg, "lockups/paseo-hub-white.svg");
const HUB_LOCKUP = parseLockup(hubLockupSvg, "lockups/hub-white.svg");

function BrandMark({ asset, props }: { asset: ParsedMark; props: React.SVGProps<SVGSVGElement> }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={asset.width}
      height={asset.height}
      viewBox={asset.viewBox}
      fill="none"
      aria-hidden="true"
      {...props}
    >
      <path
        d={asset.path}
        stroke="currentColor"
        strokeWidth={asset.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BrandLockup({
  asset,
  props,
}: {
  asset: ParsedLockup;
  props: React.SVGProps<SVGSVGElement>;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={asset.width}
      height={asset.height}
      viewBox={asset.viewBox}
      fill="none"
      aria-hidden="true"
      {...props}
    >
      <path
        d={asset.path}
        stroke="currentColor"
        strokeWidth={asset.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d={asset.wordmarkPath} fill="currentColor" />
    </svg>
  );
}

/** Canonical Paseo butterfly mark (700x700 viewBox, stroked with currentColor). */
export function PaseoMark(props: React.SVGProps<SVGSVGElement>) {
  return <BrandMark asset={PASEO_MARK} props={props} />;
}

/** Canonical Paseo Hub five-petal flower mark (700x700 viewBox, stroked with currentColor). */
export function PaseoHubMark(props: React.SVGProps<SVGSVGElement>) {
  return <BrandMark asset={PASEO_HUB_MARK} props={props} />;
}

/** Canonical Paseo lockup (butterfly mark at 94% optical scale + Plus Jakarta Sans SemiBold). */
export function PaseoLockup(props: React.SVGProps<SVGSVGElement>) {
  return <BrandLockup asset={PASEO_LOCKUP} props={props} />;
}

/** Canonical Paseo Hub lockup (flower mark + Plus Jakarta Sans SemiBold). */
export function PaseoHubLockup(props: React.SVGProps<SVGSVGElement>) {
  return <BrandLockup asset={PASEO_HUB_LOCKUP} props={props} />;
}

/** Canonical Hub lockup (flower mark + "Hub"), used where Paseo is already on screen. */
export function HubLockup(props: React.SVGProps<SVGSVGElement>) {
  return <BrandLockup asset={HUB_LOCKUP} props={props} />;
}
