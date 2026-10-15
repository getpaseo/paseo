const NON_PRINTABLE_ASCII = /[^\x20-\x7e]/g;
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/;
const QUOTED_STRING_SPECIALS = /[\\"]/g;
const NON_ATTR_CHARS_LEFT_BY_URI_ENCODING = /['()*]/g;

/**
 * Content-Disposition for a file download (RFC 6266).
 *
 * Any name that is not plain ASCII also gets `filename*=UTF-8''…`, because
 * browsers do not read raw Latin-1 bytes in `filename` and fall back to a name
 * taken from the URL. A name with a percent escape gets it too, so browsers do
 * not decode the escape in `filename`.
 */
export function formatAttachmentContentDisposition(fileName: string): string {
  const asciiFileName = fileName.replace(NON_PRINTABLE_ASCII, "?");
  const disposition = `attachment; filename=${quote(asciiFileName)}`;
  if (asciiFileName === fileName && !PERCENT_ESCAPE.test(fileName)) {
    return disposition;
  }
  return `${disposition}; filename*=UTF-8''${encodeExtendedValue(fileName)}`;
}

function quote(value: string): string {
  return `"${value.replace(QUOTED_STRING_SPECIALS, "\\$&")}"`;
}

function encodeExtendedValue(value: string): string {
  return encodeURIComponent(value).replace(
    NON_ATTR_CHARS_LEFT_BY_URI_ENCODING,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
