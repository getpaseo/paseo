export interface FilePanelFile {
  path: string;
  kind: "text" | "image" | "binary";
  size: number;
  hasBytes: boolean;
}

export interface FilePanelSelector {
  extensions: readonly string[];
  filenames?: readonly string[];
}

export interface FilePanelCandidate {
  id: string;
  files: FilePanelSelector;
  document: "text" | "bytes";
  maxBytes: number;
}

export interface FilePanelResolution<Candidate> {
  panel: Candidate | null;
  candidates: readonly Candidate[];
  selectorKey: string;
}

export function filePanelExtension(path: string): string {
  const name = filePanelBasename(path);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function filePanelBasename(path: string): string {
  return path.trim().split(/[\\/]/).pop() ?? "";
}

function matchesSelector(file: FilePanelFile, selector: FilePanelSelector): boolean {
  if (selector.filenames?.includes(filePanelBasename(file.path))) return true;
  const extension = filePanelExtension(file.path);
  return selector.extensions.some((entry) => entry.toLowerCase() === extension);
}

export function resolveFilePanel<Candidate extends FilePanelCandidate>(input: {
  file: FilePanelFile;
  candidates: readonly Candidate[];
  associations: Readonly<Record<string, string>>;
}): FilePanelResolution<Candidate> {
  const { file, associations } = input;
  const candidates = input.candidates.filter((candidate) => {
    const documentAvailable = candidate.document === "text" ? file.kind === "text" : file.hasBytes;
    return (
      documentAvailable && file.size <= candidate.maxBytes && matchesSelector(file, candidate.files)
    );
  });
  const filename = filePanelBasename(file.path);
  const matchedFilename = candidates.some((candidate) =>
    candidate.files.filenames?.includes(filename),
  );
  const selectorKey = matchedFilename ? `name:${filename}` : `ext:${filePanelExtension(file.path)}`;
  const association = associations[selectorKey];
  const panel =
    candidates.find((candidate) => candidate.id === association) ?? candidates[0] ?? null;
  return { panel, candidates, selectorKey };
}
