import type { TFunction } from "i18next";
import { formatDuration } from "@/utils/time";

export function getTurnDurationLabel(durationMs: number, t: TFunction): string {
  return t("message.turnFooter.workedFor", { duration: formatDuration(durationMs) });
}
