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
export type FilePanelFiles = FilePanelSelector | "all";

export interface FilePanelCandidate {
  id: string;
  /** Paseo's own panel. Paseo asks which panel opens a file only when a plugin panel claims it. */
  builtin: boolean;
  files: FilePanelFiles;
  /** The only kind of file a built-in panel reads. Plugin panels are offered for any kind. */
  fileKind?: FilePanelFileKind;
}

export interface FilePanelResolution<Candidate> {
  panel: Candidate | null;
  candidates: readonly Candidate[];
  selectorKey: string;
  /** The remembered candidate for `selectorKey`, when this host has it. */
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
  kind: "ext" | "name";
  value: string;
}

function filePanelSelectorKey(key: FilePanelSelectorKey): string {
  return `${key.kind}:${key.value}`;
}

export function parseFilePanelSelectorKey(selectorKey: string): FilePanelSelectorKey {
  const separator = selectorKey.indexOf(":");
  const kind = selectorKey.slice(0, separator) === "name" ? "name" : "ext";
  return { kind, value: selectorKey.slice(separator + 1) };
}

function matchesFiles(file: FilePanelFile, files: FilePanelFiles): boolean {
  if (files === "all") return true;
  return matchesName(filePanelBasename(file.path), filePanelExtension(file.path), files);
}

function claimsFilename(files: FilePanelFiles, filename: string): boolean {
  return files !== "all" && Boolean(files.filenames?.includes(filename));
}

function matchesName(name: string, extension: string, selector: FilePanelSelector): boolean {
  if (selector.filenames?.includes(name)) return true;
  return selector.extensions.some((entry) => entry.toLowerCase() === extension);
}

/** The selector keys a panel claims by name: one per extension and one per filename. */
export function filePanelClaimedSelectorKeys(files: FilePanelFiles): string[] {
  if (files === "all") return [];
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
  selector: FilePanelSelector,
  selectorKey: string,
): boolean {
  const { kind, value } = parseFilePanelSelectorKey(selectorKey);
  return kind === "name"
    ? matchesName(value, filePanelExtension(value), selector)
    : matchesName("", value, selector);
}

/** Paseo asks which panel opens a file only when a plugin panel is one of several candidates. */
export function asksForFilePanel(candidates: readonly FilePanelCandidate[]): boolean {
  return candidates.length > 1 && candidates.some((candidate) => !candidate.builtin);
}

export function resolveFilePanel<Candidate extends FilePanelCandidate>(input: {
  file: FilePanelFile;
  candidates: readonly Candidate[];
  associations: Readonly<Record<string, string>>;
  /** A panel chosen for this tab open; wins over the association while it is a candidate. */
  choice?: string | null;
}): FilePanelResolution<Candidate> {
  const { file, associations } = input;
  const candidates = input.candidates.filter(
    (candidate) =>
      (candidate.fileKind === undefined || candidate.fileKind === file.kind) &&
      matchesFiles(file, candidate.files),
  );
  const filename = filePanelBasename(file.path);
  const matchedFilename = candidates.some((candidate) => claimsFilename(candidate.files, filename));
  const selectorKey = matchedFilename
    ? filePanelSelectorKey({ kind: "name", value: filename })
    : filePanelSelectorKey({ kind: "ext", value: filePanelExtension(file.path) });
  const associated = candidates.find((candidate) => candidate.id === associations[selectorKey]);
  const chosen = candidates.find((candidate) => candidate.id === input.choice);
  const panel = chosen ?? associated ?? candidates[0] ?? null;
  return { panel, candidates, selectorKey, associatedPanelId: associated?.id ?? null };
}
