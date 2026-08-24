import type { ScheduleCadence } from "@getpaseo/protocol/schedule/types";

type CronCadence = Extract<ScheduleCadence, { type: "cron" }>;

export function nextCronCadence(
  current: ScheduleCadence,
  expression: string,
  deviceTimeZone: string,
): CronCadence {
  if (current.type === "cron") {
    return { type: "cron", expression, timezone: current.timezone ?? "UTC" };
  }
  return { type: "cron", expression, timezone: deviceTimeZone };
}
