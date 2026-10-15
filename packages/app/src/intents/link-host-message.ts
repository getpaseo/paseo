import type { TFunction } from "i18next";
import type { LinkHostResolution } from "./automation-link";

export function describeLinkHostFailure(
  t: TFunction,
  resolution: Exclude<LinkHostResolution, { kind: "resolved" }>,
): string {
  switch (resolution.kind) {
    case "unknownHost":
      return t("intents.links.unknownHost", { serverId: resolution.serverId });
    case "noHosts":
      return t("intents.links.noHosts");
    case "ambiguous":
      return t("intents.links.ambiguousHost");
  }
}
