// Test stub for expo-clipboard. The sidebar clipboard actions write strings; nothing in tests
// reads or renders the paste button, and the package ships uncompiled JSX in its .js build.
export const setStringAsync = async () => undefined;
export const getStringAsync = async () => "";
export const setImageAsync = async () => undefined;
export const hasStringAsync = async () => false;

export function ClipboardPasteButton(): null {
  return null;
}
