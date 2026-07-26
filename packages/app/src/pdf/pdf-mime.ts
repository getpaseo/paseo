export const PDF_MIME_TYPE = "application/pdf";

/**
 * Keyed on the mime, never on the read result's `kind`: a PDF arrives as
 * `kind: "binary"` so that a daemon serving a type this client doesn't know
 * still parses. The mime is where new previewable types show up.
 */
export function isPdfFile(input: { mimeType?: string } | null | undefined): boolean {
  const essence = input?.mimeType?.split(";")[0].trim().toLowerCase();
  return essence === PDF_MIME_TYPE;
}

/**
 * Only for telling "this daemon is too old to type PDFs" apart from "this is
 * some other binary". Never use it to decide to render: the bytes could be
 * anything, and the platform viewer is what finds out.
 */
export function hasPdfExtension(filePath: string): boolean {
  return filePath.trim().toLowerCase().endsWith(".pdf");
}
