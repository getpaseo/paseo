import { createContext, useContext, useState, type ReactNode } from "react";
import invariant from "tiny-invariant";
import { buildDiffDocumentModel, retainReusableModels, reviewGeometryKey } from "./model";
import type {
  BuildDiffDocumentModelInput,
  DiffDocumentModel,
  DiffPalette,
  DiffTypography,
  TextMeasurer,
} from "./types";

const MAX_MODEL_VARIANTS = 4;
const MAX_TYPOGRAPHY_RESOURCES = 4;

interface ModelVariant {
  measureText: TextMeasurer;
  key: string;
  exactKey: string;
  model: DiffDocumentModel;
  models: DiffDocumentModel[];
}

interface TypographyResourceInput {
  typography: DiffTypography;
  load: () => Promise<void>;
  createMeasurer: () => TextMeasurer;
}

export interface DiffTypographyResource {
  typography: DiffTypography;
  measureText: TextMeasurer;
  isReady(): boolean;
  load(): Promise<DiffTypography>;
}

export interface DiffDocumentWorkspaceCache {
  buildModel(input: Omit<BuildDiffDocumentModelInput, "reuseFrom">): DiffDocumentModel;
  typography(input: TypographyResourceInput): DiffTypographyResource;
}

export function createDiffDocumentWorkspaceCache(): DiffDocumentWorkspaceCache {
  let variants: ModelVariant[] = [];
  const typographyResources = new Map<string, DiffTypographyResource>();

  return {
    buildModel(input) {
      const key = modelVariantKey(input);
      const exactKey = exactModelKey(input);
      const variantIndex = variants.findIndex(
        (candidate) => candidate.key === key && candidate.measureText === input.measureText,
      );
      const variant = variantIndex === -1 ? undefined : variants[variantIndex];
      if (
        variant?.exactKey === exactKey &&
        variant.model.files.length === input.files.length &&
        variant.model.files.every((file, index) => file.file === input.files[index])
      ) {
        variants.splice(variantIndex, 1);
        variants.unshift(variant);
        return variant.model;
      }
      const model = buildDiffDocumentModel({ ...input, reuseFrom: variant?.models });
      const nextVariant = {
        measureText: input.measureText,
        key,
        exactKey,
        model,
        models: retainReusableModels(variant?.models, model),
      };
      if (variantIndex !== -1) variants.splice(variantIndex, 1);
      variants.unshift(nextVariant);
      variants = variants.slice(0, MAX_MODEL_VARIANTS);
      return model;
    },
    typography(input) {
      const key = typographyKey(input.typography);
      const existing = typographyResources.get(key);
      if (existing) {
        typographyResources.delete(key);
        typographyResources.set(key, existing);
        return existing;
      }
      const resource = createTypographyResource(input);
      typographyResources.set(key, resource);
      while (typographyResources.size > MAX_TYPOGRAPHY_RESOURCES) {
        const oldestKey = typographyResources.keys().next().value;
        if (oldestKey === undefined) break;
        typographyResources.delete(oldestKey);
      }
      return resource;
    },
  };
}

function createTypographyResource(input: TypographyResourceInput): DiffTypographyResource {
  let ready = false;
  let pending: Promise<DiffTypography> | null = null;
  return {
    typography: input.typography,
    measureText: input.createMeasurer(),
    isReady: () => ready,
    load() {
      if (ready) return Promise.resolve(input.typography);
      pending ??= input.load().then(() => {
        ready = true;
        return input.typography;
      });
      return pending;
    },
  };
}

function modelVariantKey(input: Omit<BuildDiffDocumentModelInput, "reuseFrom">): string {
  return JSON.stringify([
    input.layout,
    input.wrapLines,
    input.viewportWidth,
    typographyKey(input.typography),
    paletteKey(input.palette),
    input.labels.binary,
    input.labels.tooLarge,
  ]);
}

function exactModelKey(input: Omit<BuildDiffDocumentModelInput, "reuseFrom">): string {
  const collapsedFilePaths = [...input.collapsedFilePaths].sort();
  const reviewGeometry = reviewGeometryKey(input.reviewActions);
  const materializationWindow = input.materializationWindow
    ? [input.materializationWindow.top, input.materializationWindow.height]
    : null;
  return JSON.stringify([collapsedFilePaths, reviewGeometry, materializationWindow]);
}

function typographyKey(typography: DiffTypography): string {
  return JSON.stringify([typography.family, typography.size, typography.lineHeight]);
}

function paletteKey(palette: DiffPalette): string {
  const syntax = Object.keys(palette.syntax)
    .sort()
    .map((name) => [name, palette.syntax[name]]);
  return JSON.stringify([
    palette.surface,
    palette.headerSurface,
    palette.border,
    palette.foreground,
    palette.foregroundMuted,
    palette.addition,
    palette.deletion,
    palette.additionBackground,
    palette.deletionBackground,
    palette.emptyBackground,
    palette.selection,
    palette.headerActiveSurface,
    palette.headerBorder,
    palette.statusSuccess,
    palette.statusDanger,
    palette.statusWarning,
    syntax,
  ]);
}

const WorkspaceCacheContext = createContext<DiffDocumentWorkspaceCache | null>(null);

export function DiffDocumentWorkspaceCacheProvider({ children }: { children: ReactNode }) {
  const [cache] = useState(createDiffDocumentWorkspaceCache);
  return <WorkspaceCacheContext.Provider value={cache}>{children}</WorkspaceCacheContext.Provider>;
}

export function useDiffDocumentWorkspaceCache(): DiffDocumentWorkspaceCache {
  const cache = useContext(WorkspaceCacheContext);
  invariant(cache, "DiffDocumentWorkspaceCacheProvider is required");
  return cache;
}
