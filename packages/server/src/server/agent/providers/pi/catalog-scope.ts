import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import type { PiModel } from "./rpc-types.js";

/** Extension file the catalog probe launches Pi with. */
export const PI_CATALOG_SCOPE_EXTENSION_FILE_NAME = "catalog-scope.mjs";
const PI_CATALOG_SCOPE_FILE_NAME = "scoped-models.json";

export interface PiCatalogScopeProbe {
  /** Extension file the catalog probe passes to Pi. */
  path: string;
  /** File Pi's resolved scope is written into. */
  scopePath: string;
  /**
   * The models Pi reported, narrowed to Pi's resolved `enabledModels` / `--models` scope and
   * ordered the way Pi orders that scope. Throws when Pi wrote no readable scope, so a failed
   * extension cannot pass for a Pi that reports none.
   */
  selectModels(available: readonly PiModel[]): PiModel[];
  cleanup: () => void;
}

/**
 * Pi's `get_available_models` RPC answers with the whole catalogue and omits the
 * `enabledModels` setting and the `--models` flag, so the probe loads a generated extension
 * that reads the scope Pi resolved for this exact launch on `session_start` and writes it out.
 */
export function createPiCatalogScopeProbe(): PiCatalogScopeProbe {
  const dir = mkdtempSync(join(tmpdir(), "paseo-pi-catalog-scope-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const path = join(dir, PI_CATALOG_SCOPE_EXTENSION_FILE_NAME);
  const scopePath = join(dir, PI_CATALOG_SCOPE_FILE_NAME);
  try {
    writeFileSync(path, catalogScopeExtensionSource(scopePath), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    cleanup();
    throw error;
  }
  return {
    path,
    scopePath,
    selectModels: (available) => selectPiCatalogModels(available, readPiScopeReferences(scopePath)),
    cleanup,
  };
}

function catalogScopeExtensionSource(scopePath: string): string {
  return `import { writeFileSync } from "node:fs";

export default function paseoCatalogScope(pi) {
  pi.on("session_start", async (_event, ctx) => {
    // COMPAT(piScopedModelsFallback): added in v0.11.2, remove after 2027-04-08 once the pi
    // floor is >=0.83.0. Only an absent property means the binary predates ctx.scopedModels;
    // a present but unreadable value throws so the probe fails instead of reading it as none.
    const scopedModels =
      ctx.scopedModels === undefined
        ? null
        : ctx.scopedModels.map((scoped) => ({
            provider: scoped.model.provider,
            id: scoped.model.id,
          }));
    writeFileSync(${JSON.stringify(scopePath)}, JSON.stringify({ scopedModels }), {
      encoding: "utf8",
      mode: 0o600,
    });
  });
}
`;
}

const PiCatalogScopeFileSchema = z.object({
  scopedModels: z
    .array(z.object({ provider: z.string().min(1), id: z.string().min(1) }))
    .nullable(),
});

/** `null` is a Pi that cannot report a scope at all. */
function readPiScopeReferences(scopePath: string): readonly string[] | null {
  let scopedModels: readonly { provider: string; id: string }[] | null;
  try {
    const payload: unknown = JSON.parse(readFileSync(scopePath, "utf8"));
    scopedModels = PiCatalogScopeFileSchema.parse(payload).scopedModels;
  } catch (error) {
    throw new Error(`Pi's catalog extension reported no readable model scope (${scopePath})`, {
      cause: error,
    });
  }

  // COMPAT(piScopedModelsFallback): added in v0.11.2, remove after 2027-04-08 once the pi
  // floor is >=0.83.0.
  if (scopedModels === null) {
    return null;
  }
  return scopedModels.map((model) => modelReference(model));
}

function selectPiCatalogModels(
  available: readonly PiModel[],
  references: readonly string[] | null,
): PiModel[] {
  // Pi treats an empty scope as no scope. A Pi that cannot report one keeps the same set.
  if (references === null || references.length === 0) {
    return [...available];
  }

  const availableByReference = new Map(available.map((model) => [modelReference(model), model]));
  const selected: PiModel[] = [];
  for (const reference of references) {
    const model = availableByReference.get(reference);
    if (model) {
      selected.push(model);
    }
  }
  return selected;
}

function modelReference(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}
