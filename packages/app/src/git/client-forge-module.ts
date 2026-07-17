import type { ComponentType } from "react";
import type { ReactNode } from "react";
import type { z } from "zod";
import type { CheckoutPrMergeMethod, CheckoutPrStatusResponse } from "@getpaseo/protocol/messages";
import type { Theme } from "@/styles/theme";
import type { Forge } from "@/git/forge";
import type { PrPaneCheck } from "@/git/pull-request-panel/data";

export interface ForgeIconProps {
  size?: number;
  color?: string;
}

export type ForgeIconComponent = ComponentType<ForgeIconProps>;

export interface ForgeBrandColor {
  light: string;
  dark: string;
}

export type ForgeIconColorMapping = (theme: Theme) => { color: string };

export interface ForgeUrlGrammar {
  /** Path infix before the branch in a tree URL, e.g. "/tree/", "/-/tree/". */
  treeInfix: string;
  /** Path infix before the branch in a blob URL, e.g. "/blob/", "/-/blob/". */
  blobInfix: string;
  /** Line/range anchor, e.g. github "#L1-L5" vs gitlab "#L1-5". */
  lineAnchor: (start: number, end?: number) => string;
}

/** Line/range anchor shared by every GitHub-family forge (github, gitea, forgejo, codeberg). */
export function GITHUB_LINE_ANCHOR(start: number, end?: number): string {
  return end && end > start ? `#L${start}-L${end}` : `#L${start}`;
}

/** URL grammar shared by the gitea-family forges (gitea, forgejo, codeberg). */
export const GITEA_FAMILY_URL_GRAMMAR: ForgeUrlGrammar = {
  treeInfix: "/src/branch/",
  blobInfix: "/src/branch/",
  lineAnchor: GITHUB_LINE_ANCHOR,
};

export type ForgeSpecificEnvelope = { forge: string } & Record<string, unknown>;

type CheckoutPrStatus = NonNullable<CheckoutPrStatusResponse["payload"]["status"]>;

export type LegacyGithubMergeFacts = NonNullable<CheckoutPrStatus["github"]>;

export interface MergeCapability {
  /** The change request can be merged directly right now. */
  directMergeReady: boolean;
  /** Auto-merge can be enabled right now. */
  canEnableAutoMerge: boolean;
  /** Auto-merge is already enabled on the change request. */
  autoMergeEnabled: boolean;
  /** The viewer is allowed to disable the active auto-merge. */
  canDisableAutoMerge: boolean;
  /** A merge queue is blocking both direct merge and auto-merge. */
  mergeBlockedByQueue: boolean;
  /** Merge methods the forge permits for this change request. */
  allowedMethods: CheckoutPrMergeMethod[];
  /** The forge's preferred/default merge method, if it reports one. */
  preferredMethod: CheckoutPrMergeMethod | null;
}

export interface PaneChecksSlotContext {
  serverId: string;
  cwd: string;
  /** Change request (PR/MR) number, so a section can address its head pipeline. */
  changeRequestNumber: number;
  open: boolean;
  onToggle: () => void;
  /** Whether the daemon advertises pluggable forge support (gates rich sections). */
  enabled: boolean;
  /**
   * Whether the daemon can serve forge check/pipeline details over the
   * forge-routed RPC. Single source of truth for gating on-demand detail
   * fetches so a section never reaches an RPC the daemon lacks.
   */
  canFetchCheckDetails: boolean;
}

export interface PaneNativeContribution {
  guard: (facts: unknown) => boolean;
  renderHeaderMeta: (facts: unknown) => ReactNode;
  renderChecksSection: (facts: unknown, ctx: PaneChecksSlotContext) => ReactNode;
}

export interface NativeFallbackCheckEntry {
  contribute: (facts: unknown, status: CheckoutPrStatus, forge: Forge) => PrPaneCheck | null;
}

interface TypedPaneContribution<TFacts extends ForgeSpecificEnvelope> {
  renderHeaderMeta?: (facts: TFacts) => ReactNode;
  renderChecksSection?: (facts: TFacts, ctx: PaneChecksSlotContext) => ReactNode;
}

interface TypedNativeFallbackCheck<TFacts extends ForgeSpecificEnvelope> {
  contribute: (facts: TFacts, status: CheckoutPrStatus, forge: Forge) => PrPaneCheck | null;
}

export interface ClientForgeFactsEntry<TFacts extends ForgeSpecificEnvelope> {
  readonly family: TFacts["forge"];
  parse: (facts: unknown) => TFacts | null;
  deriveMergeCapability: (facts: unknown) => MergeCapability | null;
  readonly nativeFallbackChecks: readonly NativeFallbackCheckEntry[];
}

export interface ClientForgeFactsRegistration<TFacts extends ForgeSpecificEnvelope> {
  readonly family: TFacts["forge"];
  readonly schema: z.ZodType<TFacts>;
  readonly deriveMergeCapability?: (facts: TFacts) => MergeCapability;
  readonly nativeFallbackChecks?: readonly NativeFallbackCheckEntry[];
}

function parseFacts<TFacts extends ForgeSpecificEnvelope>(
  schema: z.ZodType<TFacts>,
  facts: unknown,
): TFacts | null {
  if (!facts) {
    return null;
  }
  const result = schema.safeParse(facts);
  return result.success ? result.data : null;
}

export function defineNativeFallbackCheck<TFacts extends ForgeSpecificEnvelope>(
  schema: z.ZodType<TFacts>,
  contribution: TypedNativeFallbackCheck<TFacts>,
): NativeFallbackCheckEntry {
  return {
    contribute: (facts, status, forge) => {
      const parsed = parseFacts(schema, facts);
      return parsed ? contribution.contribute(parsed, status, forge) : null;
    },
  };
}

export function definePaneContribution<TFacts extends ForgeSpecificEnvelope>(
  schema: z.ZodType<TFacts>,
  contribution: TypedPaneContribution<TFacts>,
): PaneNativeContribution {
  return {
    guard: (facts) => parseFacts(schema, facts) !== null,
    renderHeaderMeta: (facts) => {
      const parsed = parseFacts(schema, facts);
      return parsed && contribution.renderHeaderMeta ? contribution.renderHeaderMeta(parsed) : null;
    },
    renderChecksSection: (facts, ctx) => {
      const parsed = parseFacts(schema, facts);
      return parsed && contribution.renderChecksSection
        ? contribution.renderChecksSection(parsed, ctx)
        : null;
    },
  };
}

export function defineForgeFacts<TFacts extends ForgeSpecificEnvelope>(
  registration: ClientForgeFactsRegistration<TFacts>,
): ClientForgeFactsEntry<TFacts> {
  return {
    family: registration.family,
    parse: (facts) => parseFacts(registration.schema, facts),
    deriveMergeCapability: (facts) => {
      if (!registration.deriveMergeCapability) {
        return null;
      }
      const parsed = parseFacts(registration.schema, facts);
      return parsed ? registration.deriveMergeCapability(parsed) : null;
    },
    nativeFallbackChecks: registration.nativeFallbackChecks ?? [],
  };
}

/**
 * Pure logic half of a forge: URL grammar and runtime-facts derivations. Kept
 * free of any React/React-Native imports so logic consumers (URL builders,
 * merge-capability, native-check fallbacks) — and the Node-based e2e harness
 * that transitively imports them — never pull the client's rendering stack.
 */
export interface ClientForgeLogicModule<
  TFacts extends ForgeSpecificEnvelope = ForgeSpecificEnvelope,
> {
  readonly id: string;
  readonly urlGrammar?: ForgeUrlGrammar;
  readonly facts?: ClientForgeFactsEntry<TFacts>;
}

/**
 * View half of a forge: the brand mark, brand color, and PR-pane render
 * contributions. Imported only by rendering code (icon lookup, the PR pane).
 */
export interface ClientForgeViewModule {
  readonly id: string;
  readonly icon: ForgeIconComponent;
  readonly brandColor?: ForgeBrandColor | null;
  readonly paneContributions?: readonly PaneNativeContribution[];
}
