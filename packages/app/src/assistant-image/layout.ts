import { MAX_CONTENT_WIDTH } from "@/constants/layout";

export const ASSISTANT_IMAGE_GALLERY_MAX_WIDTH = 320;
export const ASSISTANT_IMAGE_GALLERY_MAX_HEIGHT = 320;
export const ASSISTANT_IMAGE_STANDALONE_MAX_WIDTH = MAX_CONTENT_WIDTH - 8;
export const ASSISTANT_IMAGE_STANDALONE_MAX_HEIGHT = 560;
export const ASSISTANT_IMAGE_LOADING_WIDTH = 240;
export const ASSISTANT_IMAGE_LOADING_HEIGHT = 160;

export interface AssistantImageDimensions {
  width: number;
  height: number;
}

interface AssistantImageAstNode {
  children?: AssistantImageAstNode[];
  content?: string;
  type?: string;
}

export function constrainAssistantImageSize(input: {
  intrinsic: AssistantImageDimensions;
  maxWidth: number;
  maxHeight: number;
}): AssistantImageDimensions {
  const scale = Math.min(
    1,
    input.maxWidth / input.intrinsic.width,
    input.maxHeight / input.intrinsic.height,
  );
  return {
    width: input.intrinsic.width * scale,
    height: input.intrinsic.height * scale,
  };
}

export function isAssistantImageGalleryParagraph(
  node: AssistantImageAstNode | null | undefined,
): boolean {
  const imageCount = countImageOnlyChildren(node?.children);
  return imageCount !== null && imageCount > 1;
}

function countImageOnlyChildren(children: AssistantImageAstNode[] | undefined): number | null {
  if (!Array.isArray(children)) return null;
  let imageCount = 0;
  for (const child of children) {
    if (child.type === "image") {
      imageCount += 1;
      continue;
    }
    const isWhitespaceText = child.type === "text" && !child.content?.trim();
    const isLineBreak = child.type === "softbreak" || child.type === "hardbreak";
    if (isWhitespaceText || isLineBreak) continue;
    if (child.type !== "inline" && child.type !== "textgroup") return null;
    const nestedImageCount = countImageOnlyChildren(child.children);
    if (nestedImageCount === null) return null;
    imageCount += nestedImageCount;
  }
  return imageCount;
}
