interface ExternalUrlOwner {
  open(url: string): Promise<void>;
}

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

const asExternalUrl = (input: unknown): URL | undefined => {
  if (typeof input !== "string" || !URL.canParse(input)) return undefined;
  const candidate = new URL(input);
  return EXTERNAL_PROTOCOLS.has(candidate.protocol) ? candidate : undefined;
};

export function createExternalUrlOpener(owner: ExternalUrlOwner) {
  return async (candidate: unknown): Promise<void> => {
    const url = asExternalUrl(candidate);
    if (url === undefined) {
      throw new Error("Only HTTP(S) URLs can open externally.");
    }
    return owner.open(url.href);
  };
}
