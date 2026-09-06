import type { BrowserElementField, BrowserElementJson } from "@/desktop/browser/element-context";

export function browserElementValueKey(value: BrowserElementJson): string {
  return JSON.stringify(value);
}

export function browserElementValuesEqual(
  left: BrowserElementJson,
  right: BrowserElementJson,
): boolean {
  return browserElementValueKey(left) === browserElementValueKey(right);
}

export function parseBrowserElementFieldValue(
  field: BrowserElementField,
  value: string,
): BrowserElementJson {
  if (field.editor !== "number" && field.editor !== "slider") return value;
  if (value.trim() === "") return "";
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

export function isBrowserElementFieldValueValid(
  field: BrowserElementField,
  value: BrowserElementJson,
): boolean {
  const isEmpty = value === null || value === "";
  if (isEmpty) return field.required !== true;
  if (field.editor !== "number" && field.editor !== "slider") return true;
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (field.min !== undefined && value < field.min) return false;
  if (field.max !== undefined && value > field.max) return false;
  if (field.step === undefined) return true;
  const stepOrigin = field.min ?? 0;
  const steps = (value - stepOrigin) / field.step;
  return Math.abs(steps - Math.round(steps)) < 1e-8;
}

export function formatBrowserElementFieldValue(
  value: BrowserElementJson,
  structured: boolean,
): string {
  if (!structured) return String(value ?? "");
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export function toColorPickerValue(value: string): string {
  const hex = value.trim().match(/^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i)?.[1];
  if (hex) {
    return hex.length === 3
      ? `#${hex
          .split("")
          .map((character) => `${character}${character}`)
          .join("")}`
      : `#${hex.slice(0, 6)}`;
  }
  const rgb = value.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i,
  );
  if (!rgb) return "#000000";
  return `#${rgb
    .slice(1, 4)
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(Number(channel))))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
