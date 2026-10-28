export type FilePanelFileKind = "text" | "image" | "binary";

/** What resolution knows about a file: its path and the kind its stat reports, never contents. */
export interface FilePanelFile {
  path: string;
  kind: FilePanelFileKind;
}

export interface FilePanelSelector {
  extensions: readonly string[];
  filenames?: readonly string[];
}

/** A selector, or `"all"`: every file of the panel's `fileKind`. */
export type FilePanelFiles = FilePanelSelector | { kind: "text" } | "all";

export interface FilePanelCandidate {
  id: string;
  /** Paseo's own panel. Paseo asks which panel opens a file only when a plugin panel claims it. */
  builtin: boolean;
  files: FilePanelFiles;
  /** The only kind of file a built-in panel reads. Plugin panels are offered for any kind. */
  fileKind?: FilePanelFileKind;
  supportsLineNavigation?: boolean;
}

export interface FilePanelResolution<Candidate> {
  panel: Candidate | null;
  candidates: readonly Candidate[];
  selectorKey: string;
  /** The filename or extension scope, before a catch-all panel broadens the choice. */
  specificSelectorKey: string;
  /** The remembered candidate for this file, when this host has it. */
  associatedPanelId: string | null;
}

export function filePanelExtension(path: string): string {
  const name = filePanelBasename(path);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function filePanelBasename(path: string): string {
  return path.trim().split(/[\\/]/).pop() ?? "";
}

/** Which files an association applies to: one extension, or one exact filename. */
export interface FilePanelSelectorKey {
  kind: "ext" | "name" | "kind";
  value: string;
}

function filePanelSelectorKey(key: FilePanelSelectorKey): string {
  return `${key.kind}:${key.value}`;
}

export function parseFilePanelSelectorKey(selectorKey: string): FilePanelSelectorKey {
  const separator = selectorKey.indexOf(":");
  const prefix = selectorKey.slice(0, separator);
  const kind = prefix === "name" || prefix === "kind" ? prefix : "ext";
  return { kind, value: selectorKey.slice(separator + 1) };
}

function matchesFiles(file: FilePanelFile, files: FilePanelFiles): boolean {
  if (files === "all") return true;
  if ("kind" in files) return file.kind === files.kind;
  return matchesName(filePanelBasename(file.path), filePanelExtension(file.path), files);
}

function claimsFilename(files: FilePanelFiles, filename: string): boolean {
  return files !== "all" && !("kind" in files) && Boolean(files.filenames?.includes(filename));
}

function matchesName(name: string, extension: string, selector: FilePanelSelector): boolean {
  if (selector.filenames?.includes(name)) return true;
  return selector.extensions.some((entry) => entry.toLowerCase() === extension);
}

/** The selector keys a panel claims by name: one per extension and one per filename. */
export function filePanelClaimedSelectorKeys(files: FilePanelFiles): string[] {
  if (files === "all") return [];
  if ("kind" in files) return [filePanelSelectorKey({ kind: "kind", value: files.kind })];
  const selector = files;
  return [
    ...selector.extensions.map((extension) =>
      filePanelSelectorKey({ kind: "ext", value: extension.toLowerCase() }),
    ),
    ...(selector.filenames ?? []).map((filename) =>
      filePanelSelectorKey({ kind: "name", value: filename }),
    ),
  ];
}

/**
 * Whether a panel is offered for files under `selectorKey`, by the resolver's matching rule. The
 * file kind depends on the file, so it is not part of the answer.
 */
export function claimsFilePanelSelectorKey(
  selector: Exclude<FilePanelFiles, "all">,
  selectorKey: string,
): boolean {
  const { kind, value } = parseFilePanelSelectorKey(selectorKey);
  if ("kind" in selector) return kind !== "kind" || selector.kind === value;
  if (kind === "kind") return false;
  return kind === "name"
    ? matchesName(value, filePanelExtension(value), selector)
    : matchesName("", value, selector);
}

/**
 * A built-in panel claiming every file of its kind (Source) is the floor: a candidate only for
 * files no other built-in panel claims, never an alternative beside one.
 */
function isBuiltinFloor(candidate: FilePanelCandidate): boolean {
  return candidate.builtin && candidate.files === "all";
}

/** Paseo asks which panel opens a file only when a plugin panel is one of several candidates. */
export function asksForFilePanel(candidates: readonly FilePanelCandidate[]): boolean {
  return candidates.length > 1 && candidates.some((candidate) => !candidate.builtin);
}

export function filePanelChoiceSelectorKey(
  panel: FilePanelCandidate | null,
  candidates: readonly FilePanelCandidate[],
  specificSelectorKey: string,
): string {
  const hasSpecificPlugin = candidates.some(
    (candidate) => !candidate.builtin && candidate.files !== "all" && !("kind" in candidate.files),
  );
  const hasKindPanel = candidates.some(
    (candidate) => candidate.files !== "all" && "kind" in candidate.files,
  );
  if (hasSpecificPlugin || !hasKindPanel || !panel) return specificSelectorKey;
  if (panel.files !== "all" && "kind" in panel.files) {
    return filePanelSelectorKey({ kind: "kind", value: panel.files.kind });
  }
  if (panel.files === "all" && panel.fileKind) {
    return filePanelSelectorKey({ kind: "kind", value: panel.fileKind });
  }
  return specificSelectorKey;
}

export function resolveFilePanel<Candidate extends FilePanelCandidate>(input: {
  file: FilePanelFile;
  candidates: readonly Candidate[];
  associations: Readonly<Record<string, string>>;
  /** A panel chosen for this tab open; wins over the association while it is a candidate. */
  choice?: string | null;
}): FilePanelResolution<Candidate> {
  const { file, associations } = input;
  const matching = input.candidates.filter(
    (candidate) =>
      (candidate.fileKind === undefined || candidate.fileKind === file.kind) &&
      matchesFiles(file, candidate.files),
  );
  const claimedByBuiltin = matching.some(
    (candidate) => candidate.builtin && candidate.files !== "all",
  );
  const candidates = claimedByBuiltin
    ? matching.filter((candidate) => !isBuiltinFloor(candidate))
    : matching;
  const filename = filePanelBasename(file.path);
  const matchedFilename = candidates.some((candidate) => claimsFilename(candidate.files, filename));
  const selectorKey = matchedFilename
    ? filePanelSelectorKey({ kind: "name", value: filename })
    : filePanelSelectorKey({ kind: "ext", value: filePanelExtension(file.path) });
  const extensionKey = filePanelSelectorKey({ kind: "ext", value: filePanelExtension(file.path) });
  const namedAssociation = candidates.find(
    (candidate) => candidate.id === associations[selectorKey],
  );
  const extensionAssociation = candidates.find(
    (candidate) => candidate.id === associations[extensionKey],
  );
  const exactAssociation = namedAssociation ?? extensionAssociation;
  const kindKey = filePanelSelectorKey({ kind: "kind", value: file.kind });
  const kindAssociation = candidates.find((candidate) => candidate.id === associations[kindKey]);
  const associated = exactAssociation ?? kindAssociation;
  const specificSelectorKey =
    extensionAssociation && !namedAssociation ? extensionKey : selectorKey;
  const chosen = candidates.find((candidate) => candidate.id === input.choice);
  const panel = chosen ?? associated ?? candidates[0] ?? null;
  let resolvedSelectorKey = filePanelChoiceSelectorKey(panel, candidates, specificSelectorKey);
  if (exactAssociation) resolvedSelectorKey = specificSelectorKey;
  if (kindAssociation && panel?.id === kindAssociation.id && !exactAssociation) {
    resolvedSelectorKey = kindKey;
  }
  return {
    panel,
    candidates,
    selectorKey: resolvedSelectorKey,
    specificSelectorKey,
    associatedPanelId: associated?.id ?? null,
  };
}
