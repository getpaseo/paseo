// The package ships JSX in .js files, which the dependency optimizer cannot parse.
export async function setStringAsync(): Promise<boolean> {
  return true;
}
export async function getStringAsync(): Promise<string> {
  return "";
}
export async function hasStringAsync(): Promise<boolean> {
  return false;
}
