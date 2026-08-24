import { z } from "zod";

export type BrowserViewport =
  | { mode: "responsive" }
  | { mode: "fixed"; width: number; height: number };

export const RESPONSIVE_BROWSER_VIEWPORT: BrowserViewport = { mode: "responsive" };

export interface BrowserRecord {
  browserId: string;
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  faviconUrl: string | null;
  lastError: string | null;
  viewport: BrowserViewport;
  createdAt: number;
}

export type BrowserRecordPatch = Partial<Omit<BrowserRecord, "browserId" | "createdAt">>;

export interface BrowserIndexState {
  browsersById: Record<string, BrowserRecord>;
}

const BrowserViewportSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("responsive") }),
  z.strictObject({
    mode: z.literal("fixed"),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
]);

const BrowserRecordSchema = z.strictObject({
  browserId: z.string(),
  url: z.string(),
  title: z.string(),
  isLoading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  faviconUrl: z.string().nullable(),
  lastError: z.string().nullable(),
  viewport: BrowserViewportSchema.optional().default(RESPONSIVE_BROWSER_VIEWPORT),
  createdAt: z.number(),
});

export const BrowserIndexStateSchema: z.ZodType<BrowserIndexState> = z.strictObject({
  browsersById: z.record(z.string(), BrowserRecordSchema),
});

export function createFixedBrowserViewport(width: number, height: number): BrowserViewport {
  return {
    mode: "fixed",
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

export function normalizeBrowserViewport(value: unknown): BrowserViewport {
  const result = BrowserViewportSchema.safeParse(value);
  return result.success && result.data.mode === "fixed"
    ? createFixedBrowserViewport(result.data.width, result.data.height)
    : RESPONSIVE_BROWSER_VIEWPORT;
}

function browserViewportsEqual(left: BrowserViewport, right: BrowserViewport): boolean {
  return (
    left.mode === right.mode &&
    (left.mode === "responsive" ||
      (right.mode === "fixed" && left.width === right.width && left.height === right.height))
  );
}

export function normalizeBrowserIndexState(value: unknown): BrowserIndexState {
  const result = BrowserIndexStateSchema.safeParse(value);
  return result.success ? result.data : { browsersById: {} };
}

export function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeBrowserUrl(value: string | null | undefined): string {
  const trimmed = trimNonEmpty(value);
  if (!trimmed) {
    return "https://example.com";
  }
  if (/^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-fA-F:.]+])(?::\d+)?(?:[/?#]|$)/.test(trimmed)) {
    return `http://${trimmed}`;
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }
  return `https://${trimmed}`;
}

export function createBrowserRecord(input: {
  browserId: string;
  initialUrl: string | null | undefined;
  now: number;
}): BrowserRecord {
  return {
    browserId: input.browserId,
    url: normalizeBrowserUrl(input.initialUrl),
    title: "",
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    lastError: null,
    viewport: RESPONSIVE_BROWSER_VIEWPORT,
    createdAt: input.now,
  };
}

export function applyBrowserPatch<S extends BrowserIndexState>(
  state: S,
  browserId: string,
  patch: BrowserRecordPatch,
): S {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return state;
  }
  const existing = state.browsersById[normalizedBrowserId];
  if (!existing) {
    return state;
  }

  const nextViewport = patch.viewport
    ? normalizeBrowserViewport(patch.viewport)
    : existing.viewport;
  const nextRecord: BrowserRecord = {
    ...existing,
    ...patch,
    viewport: nextViewport,
    url: normalizeBrowserUrl(patch.url ?? existing.url),
  };

  if (
    nextRecord.url === existing.url &&
    nextRecord.title === existing.title &&
    nextRecord.isLoading === existing.isLoading &&
    nextRecord.canGoBack === existing.canGoBack &&
    nextRecord.canGoForward === existing.canGoForward &&
    nextRecord.faviconUrl === existing.faviconUrl &&
    nextRecord.lastError === existing.lastError &&
    browserViewportsEqual(nextRecord.viewport, existing.viewport)
  ) {
    return state;
  }

  return {
    ...state,
    browsersById: {
      ...state.browsersById,
      [normalizedBrowserId]: nextRecord,
    },
  };
}

export function removeBrowserFromIndex<S extends BrowserIndexState>(
  state: S,
  browserId: string,
): S {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return state;
  }
  if (!state.browsersById[normalizedBrowserId]) {
    return state;
  }
  const next = { ...state.browsersById };
  delete next[normalizedBrowserId];
  return { ...state, browsersById: next };
}

export function sanitizeBrowsersForPersist(state: BrowserIndexState): {
  browsersById: Record<string, BrowserRecord>;
} {
  return {
    browsersById: Object.fromEntries(
      Object.entries(state.browsersById).map(([browserId, browser]) => [
        browserId,
        { ...browser, isLoading: false, lastError: null },
      ]),
    ),
  };
}
