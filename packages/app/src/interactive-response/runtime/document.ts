import { artifactRuntimeHtml } from "./html.gen";
export interface ArtifactConfig {
  session: string;
  html: string;
  initial?: string;
  disabled: boolean;
  colorScheme?: "light" | "dark";
}
export function artifactDocument(config: ArtifactConfig): string {
  const serialized = JSON.stringify(config).replace(/</g, "\\u003c");
  return artifactRuntimeHtml.replace("__PASEO_ARTIFACT_CONFIG__", () => serialized);
}
