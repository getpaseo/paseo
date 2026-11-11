/** Decodes UTF-8 text, dropping a leading byte order mark and replacing malformed sequences. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
