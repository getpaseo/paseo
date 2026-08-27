import { createContext, useContext, useState, type ReactNode } from "react";
import invariant from "tiny-invariant";
import { buildDiffDocumentModel, retainReusableModels } from "./model";
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
  const variantsByFiles = new WeakMap<BuildDiffDocumentModelInput["files"], ModelVariant[]>();
  const typographyResources = new Map<string, DiffTypographyResource>();

  return {
    buildModel(input) {
      const key = modelVariantKey(input);
      const exactKey = exactModelKey(input);
      const variants = variantsByFiles.get(input.files) ?? [];
      const variantIndex = variants.findIndex((candidate) => candidate.key === key);
      const variant = variantIndex === -1 ? undefined : variants[variantIndex];
      if (variant?.exactKey === exactKey) {
        variants.splice(variantIndex, 1);
        variants.unshift(variant);
        return variant.model;
      }
      const model = buildDiffDocumentModel({ ...input, reuseFrom: variant?.models });
      const nextVariant = {
        key,
        exactKey,
        model,
        models: retainReusableModels(variant?.models, model),
      };
      if (variantIndex !== -1) variants.splice(variantIndex, 1);
      variants.unshift(nextVariant);
      variantsByFiles.set(input.files, variants.slice(0, MAX_MODEL_VARIANTS));
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
  const reviewGeometry = input.reviewActions
    ? {
        comments: [...input.reviewActions.commentsByTarget.entries()]
          .map(([target, comments]) => [target, comments.map((comment) => comment.id).sort()])
          .sort(([left], [right]) => String(left).localeCompare(String(right))),
        editor: input.reviewActions.editor
          ? [input.reviewActions.editor.target.key, input.reviewActions.editor.commentId]
          : null,
      }
    : null;
  return JSON.stringify([collapsedFilePaths, reviewGeometry]);
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
