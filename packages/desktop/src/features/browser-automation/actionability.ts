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

export async function waitForActionableTarget(input: {
  page: SnapshotPage;
  elementExpression: string;
  editable?: boolean;
  timeoutMs?: number;
}): Promise<ActionabilityResult> {
  const result = await input.page.executeJavaScript(
    buildActionabilityScript({
      elementExpression: input.elementExpression,
      editable: input.editable === true,
      timeoutMs: input.timeoutMs ?? DEFAULT_ACTIONABILITY_TIMEOUT_MS,
    }),
  );
  return readActionabilityResult(result);
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
  timeoutMs: number;
}): string {
  return String.raw`(async () => {
    const deadline = performance.now() + ${JSON.stringify(input.timeoutMs)};
    const requiresEditable = ${JSON.stringify(input.editable)};

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // Electron can suspend requestAnimationFrame while a guest is parked after
    // workspace LRU eviction even though the guest remains CDP-controllable.
    // Timed layout samples keep background browser automation live.
    const waitForLayout = () => sleep(16);
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

    let detail = 'not actionable';
    while (performance.now() <= deadline) {
      const element = resolveElement();
      if (!element || !element.isConnected) {
        return { ok: false, reason: 'stale_ref', detail: 'ref no longer resolves' };
      }

      const rect = element.getBoundingClientRect();
      if (!isVisible(element, rect)) {
        detail = 'not visible';
        await sleep(25);
        continue;
      }
      if (isDisabled(element)) {
        detail = 'disabled';
        await sleep(25);
        continue;
      }
      if (requiresEditable && !isEditable(element)) {
        detail = 'not editable';
        await sleep(25);
        continue;
      }

      element.scrollIntoView?.({ block: 'center', inline: 'center' });
      await waitForLayout();
      const firstRect = element.getBoundingClientRect();
      await waitForLayout();
      const secondRect = element.getBoundingClientRect();
      if (!sameRect(firstRect, secondRect)) {
        detail = 'moving';
        continue;
      }

      const point = centerPoint(secondRect);
      if (!hitTargetReceivesEvents(element, point)) {
        detail = 'covered';
        await sleep(25);
        continue;
      }

      return { ok: true, target: { point, rect: rectPayload(secondRect) } };
    }

    return { ok: false, reason: 'timeout', detail };
  })()`;
}
