export interface AssistantImageDimensions {
  width: number;
  height: number;
}

interface AssistantImageDimensionCandidate {
  width?: unknown;
  height?: unknown;
}

export interface AssistantImageRenderedDimensionsReader {
  read(renderedImage: unknown): AssistantImageDimensions | null;
}

function readPositiveDimensions(
  candidate: AssistantImageDimensionCandidate | null | undefined,
): AssistantImageDimensions | null {
  if (
    typeof candidate?.width !== "number" ||
    typeof candidate.height !== "number" ||
    candidate.width <= 0 ||
    candidate.height <= 0
  ) {
    return null;
  }
  return { width: candidate.width, height: candidate.height };
}

export function resolveAssistantImageLoadDimensions(input: {
  source?: AssistantImageDimensionCandidate | null;
  target?: { naturalWidth?: unknown; naturalHeight?: unknown } | null;
  renderedImage: unknown;
  renderedDimensions: AssistantImageRenderedDimensionsReader;
}): AssistantImageDimensions | null {
  const source = readPositiveDimensions(input.source);
  if (source) {
    return source;
  }

  const target = readPositiveDimensions({
    width: input.target?.naturalWidth,
    height: input.target?.naturalHeight,
  });
  return target ?? input.renderedDimensions.read(input.renderedImage);
}
