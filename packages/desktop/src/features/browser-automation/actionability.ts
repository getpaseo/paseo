import type { SnapshotPage } from "./snapshot-engine.js";

export interface ActionablePoint {
  x: number;
  y: number;
}

export interface ActionableTarget {
  point: ActionablePoint;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export type ActionabilityResult =
  | { ok: true; target: ActionableTarget }
  | { ok: false; reason: "stale_ref" | "timeout"; detail?: string };

const DEFAULT_ACTIONABILITY_TIMEOUT_MS = 5_000;

/** Poll a ref until it is enabled, unobscured and stable across layout samples.
 * Require editability for text input. Main-process timers preserve the timeout
 * when Electron suspends a hidden guest's animation and timer queues.
 */
export async function waitForActionableTarget(input: {
  page: SnapshotPage;
  elementExpression: string;
  editable?: boolean;
  timeoutMs?: number;
}): Promise<ActionabilityResult> {
  const deadline = Date.now() + (input.timeoutMs ?? DEFAULT_ACTIONABILITY_TIMEOUT_MS);
  let previousRect: ActionableTarget["rect"] | null = null;
  let detail = "not actionable";

  // Hidden guests can suspend their timer queue. Sample layout using main's
  // clock without waking rendering or changing the guest's visibility.
  while (Date.now() < deadline) {
    const sample = await sampleBeforeDeadline({
      page: input.page,
      script: buildActionabilityScript({
        elementExpression: input.elementExpression,
        editable: input.editable === true,
        previousRect,
      }),
      deadline,
    });
    if (sample.timedOut) {
      return {
        ok: false,
        reason: "timeout",
        detail: "renderer did not respond before the deadline",
      };
    }
    const result = readActionabilityResult(sample.value);
    if (result.ok || result.reason === "stale_ref") return result;
    detail = result.detail ?? detail;
    previousRect = readSampleRect(sample.value);
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  }
  return { ok: false, reason: "timeout", detail };
}

type ActionabilitySample = { timedOut: true } | { timedOut: false; value: unknown };

interface ActionabilitySampleRequest {
  page: SnapshotPage;
  script: string;
  deadline: number;
}

/** Bound each renderer round trip with the same main-process deadline. */
async function sampleBeforeDeadline({
  page,
  script,
  deadline,
}: ActionabilitySampleRequest): Promise<ActionabilitySample> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { timedOut: true };
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ActionabilitySample>((resolve) => {
    timeoutId = setTimeout(() => resolve({ timedOut: true }), remaining);
  });
  try {
    return await Promise.race([
      page
        .executeJavaScript(script)
        .then((value): ActionabilitySample => ({ timedOut: false, value })),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Retain geometry only for a target ready for a stability check. */
function readSampleRect(value: unknown): ActionableTarget["rect"] | null {
  if (!value || typeof value !== "object") return null;
  const rect = (value as Record<string, unknown>).rect;
  return isRect(rect) ? rect : null;
}

function readActionabilityResult(value: unknown): ActionabilityResult {
  if (!value || typeof value !== "object") {
    return { ok: false, reason: "timeout" };
  }
  const record = value as Record<string, unknown>;
  if (record.ok === true && isActionableTarget(record.target)) {
    return { ok: true, target: record.target };
  }
  if (record.ok === false) {
    const reason = record.reason;
    if (reason === "stale_ref" || reason === "timeout") {
      return {
        ok: false,
        reason,
        ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
      };
    }
  }
  return { ok: false, reason: "timeout" };
}

function isActionableTarget(value: unknown): value is ActionableTarget {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return isPoint(record.point) && isRect(record.rect);
}

function isPoint(value: unknown): value is ActionablePoint {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return isFiniteNumber(record.x) && isFiniteNumber(record.y);
}

function isRect(value: unknown): value is ActionableTarget["rect"] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isFiniteNumber(record.x) &&
    isFiniteNumber(record.y) &&
    isFiniteNumber(record.width) &&
    isFiniteNumber(record.height)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function buildActionabilityScript(input: {
  elementExpression: string;
  editable: boolean;
  previousRect: ActionableTarget["rect"] | null;
}): string {
  return String.raw`(() => {
    const previousRect = ${JSON.stringify(input.previousRect)};
    const requiresEditable = ${JSON.stringify(input.editable)};

    const nearlyEqual = (a, b) => Math.abs(a - b) < 0.25;
    const sameRect = (a, b) =>
      nearlyEqual(a.x, b.x) &&
      nearlyEqual(a.y, b.y) &&
      nearlyEqual(a.width, b.width) &&
      nearlyEqual(a.height, b.height);
    const rectPayload = (rect) => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
    const centerPoint = (rect) => ({
      x: Math.min(Math.max(rect.left + rect.width / 2, 0), Math.max(window.innerWidth - 1, 0)),
      y: Math.min(Math.max(rect.top + rect.height / 2, 0), Math.max(window.innerHeight - 1, 0)),
    });
    const isDisabled = (element) => {
      if (element.closest?.('[aria-disabled="true"]')) return true;
      if ('disabled' in element && element.disabled) return true;
      const fieldset = element.closest?.('fieldset[disabled]');
      return Boolean(fieldset);
    };
    const isEditable = (element) => {
      if (element.isContentEditable) return true;
      const tag = element.tagName?.toLowerCase();
      if (tag === 'textarea' || tag === 'select') return !element.readOnly && !isDisabled(element);
      if (tag !== 'input') return false;
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type)) return false;
      return !element.readOnly && !isDisabled(element);
    };
    const isVisible = (element, rect) => {
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity || '1') !== 0
      );
    };
    const hitTargetReceivesEvents = (element, point) => {
      const hit = document.elementFromPoint(point.x, point.y);
      return Boolean(hit && (hit === element || element.contains(hit)));
    };
    const resolveElement = () => (${input.elementExpression});

    const element = resolveElement();
    if (!element || !element.isConnected) {
      return { ok: false, reason: 'stale_ref', detail: 'ref no longer resolves' };
    }
    const rect = element.getBoundingClientRect();
    if (!isVisible(element, rect)) {
      return { ok: false, reason: 'timeout', detail: 'not visible' };
    }
    if (isDisabled(element)) {
      return { ok: false, reason: 'timeout', detail: 'disabled' };
    }
    if (requiresEditable && !isEditable(element)) {
      return { ok: false, reason: 'timeout', detail: 'not editable' };
    }
    if (!previousRect) {
      element.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' });
    }
    const currentRect = element.getBoundingClientRect();
    if (!previousRect || !sameRect(previousRect, currentRect)) {
      return { ok: false, reason: 'timeout', detail: 'moving', rect: rectPayload(currentRect) };
    }
    const point = centerPoint(currentRect);
    if (!hitTargetReceivesEvents(element, point)) {
      return { ok: false, reason: 'timeout', detail: 'covered' };
    }
    return { ok: true, target: { point, rect: rectPayload(currentRect) } };
  })()`;
}
