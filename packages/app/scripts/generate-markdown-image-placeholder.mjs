// Regenerate from the repo root: node packages/app/scripts/generate-markdown-image-placeholder.mjs
// sharp is already provided by the development dependency tree; it is not used at runtime.
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

// Lucide Image (ISC), lucide-react-native/dist/esm/icons/image.mjs.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
  <svg x="293.333333" y="293.333333" width="53.333333" height="53.333333" viewBox="0 0 24 24">
    <g fill="none" stroke="#808080" opacity="0.6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>
      <circle cx="9" cy="9" r="2"/>
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
    </g>
  </svg>
</svg>`;
const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
const uri = `data:image/png;base64,${png.toString("base64")}`;
const sourceFile = new URL("../src/components/markdown/source.ts", import.meta.url);
const source = await readFile(sourceFile, "utf8");
await writeFile(
  sourceFile,
  source.replace(
    /export const PENDING_MARKDOWN_IMAGE =\s*"[^"]*";/,
    `export const PENDING_MARKDOWN_IMAGE =\n  "${uri}";`,
  ),
);
console.log(`Generated 640×640 Markdown image placeholder: ${png.length} bytes`);
