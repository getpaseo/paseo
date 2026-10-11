/**
 * Browser-test stub for expo-clipboard: the real web entry contains JSX files that break
 * Vite's dependency optimization, and tests fake the clipboard anyway.
 */
export async function setStringAsync(): Promise<boolean> {
  return true;
}

export async function getStringAsync(): Promise<string> {
  return "";
}

export default { setStringAsync, getStringAsync };
