export async function copyText(text: string): Promise<void> {
  const { setStringAsync } = require("expo-clipboard") as typeof import("expo-clipboard");
  if (!(await setStringAsync(text))) {
    throw new Error("Clipboard copy was denied or is unavailable");
  }
}
