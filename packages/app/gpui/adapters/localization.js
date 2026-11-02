import Desktop from "../desktop/src/NativePaseoDesktop";
export function getLocales() {
  const languageTag = Desktop.locale().split(".")[0].replaceAll("_", "-");
  return [{ languageTag, languageCode: languageTag.split("-")[0] }];
}
