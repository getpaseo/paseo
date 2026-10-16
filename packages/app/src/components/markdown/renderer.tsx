import { memo, useMemo, useState } from "react";
import { EnrichedMarkdownText, type LinkPressEvent } from "react-native-enriched-markdown";
import { withUnistyles } from "react-native-unistyles";
import {
  useAssistantFileLinkActions,
  useAssistantFileLinkEnvironment,
} from "@/assistant-file-links";
import { useStableEvent } from "@/hooks/use-stable-event";
import { AttachmentLightbox, type ImageLightboxSource } from "@/components/attachment-lightbox";
import type { Theme } from "@/styles/theme";
import { isWeb } from "@/constants/platform";
import { MarkdownRendererFrame } from "./frame";
import { WEB_RENDERERS } from "./renderers";
import { createMarkdownStyles } from "./styles";
import { PENDING_MARKDOWN_IMAGE } from "./source";
import { splitStreamingMarkdown } from "./streaming";
import { useMarkdownSource, type MarkdownImageContext } from "./images";

import { MermaidFence, MermaidStreamingContext, splitMermaidFences } from "./fence/mermaid";

const ThemedMarkdown = withUnistyles(EnrichedMarkdownText);
const MD4C_FLAGS = { latexMath: false, hardSoftBreaks: true, admonitions: true };

const regularStyle = (theme: Theme) => createMarkdownStyles(theme);
const compactStyle = (theme: Theme) => createMarkdownStyles(theme, true);
const WEB_CONTAINER = { userSelect: "text" as const };

export interface MarkdownRendererProps extends MarkdownImageContext {
  text: string;
  compact?: boolean;
  streaming?: boolean;
  onLinkPress?: (url: string) => unknown;
}

/** All Markdown surfaces share the same engine and source adaptation. */
export const MarkdownRenderer = memo(function MarkdownRenderer(props: MarkdownRendererProps) {
  const streaming = !isWeb && !!props.streaming;
  // Only completed lines affect block closure. Do not run mdast on every reveal frame.
  const completeLines = streaming ? props.text.slice(0, props.text.lastIndexOf("\n") + 1) : "";
  const boundary = useMemo(
    () => splitStreamingMarkdown(completeLines, true).head.length,
    [completeLines],
  );
  if (!streaming || boundary === 0) return <MarkdownPart {...props} />;
  return (
    <>
      <MarkdownPart {...props} text={props.text.slice(0, boundary)} continues />
      <MarkdownPart {...props} text={props.text.slice(boundary)} />
    </>
  );
});

const MarkdownPart = memo(function MarkdownPart({
  text,
  continues = false,
  compact = false,
  streaming = false,
  onLinkPress,
  ...imageContext
}: MarkdownRendererProps & { continues?: boolean }) {
  const environment = useAssistantFileLinkEnvironment();
  const actions = useAssistantFileLinkActions();
  const client =
    imageContext.client ??
    (environment.client?.readFile
      ? { readFile: environment.client.readFile.bind(environment.client) }
      : undefined);
  const { markdown, imageSources, linkRecognition, linkSource } = useMarkdownSource(text, {
    workspaceRoot: environment.workspaceRoot,
    serverId: environment.serverId,
    ...imageContext,
    client,
  });
  const [image, setImage] = useState<ImageLightboxSource | null>(null);
  const pressLink = useStableEvent(({ url, sourceType }: LinkPressEvent) => {
    const source = linkSource(url, sourceType);
    if (onLinkPress && !actions.canResolveFile(source)) onLinkPress(url);
    else actions.open(source, "preferred");
  });
  const pressImage = useStableEvent(({ url }: { url: string }) => {
    if (url !== PENDING_MARKDOWN_IMAGE) setImage({ type: "uri", uri: url });
  });
  const closeImage = useStableEvent(() => setImage(null));
  const segments = useMemo(
    () =>
      isWeb ? [{ kind: "markdown", id: "0", source: markdown }] : splitMermaidFences(markdown),
    [markdown],
  );
  const content = (
    <MermaidStreamingContext.Provider value={streaming}>
      {segments.map((segment) =>
        segment.kind === "mermaid" ? (
          <MermaidFence key={`${segment.kind}:${segment.id}`} code={segment.source} />
        ) : (
          <ThemedMarkdown
            key={`${segment.kind}:${segment.id}`}
            markdown={segment.source}
            containerStyle={isWeb ? WEB_CONTAINER : undefined}
            uniProps={compact ? compactStyle : regularStyle}
            flavor="github"
            selectable
            allowTrailingMargin={continues && segment === segments[segments.length - 1]}
            md4cFlags={MD4C_FLAGS}
            linkRecognition={linkRecognition}
            enableTaskListItemToggle={false}
            enableLinkPreview={false}
            enableBlockContextMenu={false}
            // JS reveal owns pacing; native fade animation is a separate experiment.
            streamingAnimation={false}
            onLinkPress={pressLink}
            onImagePress={pressImage}
            renderers={isWeb ? WEB_RENDERERS : undefined}
          />
        ),
      )}
      {image ? <AttachmentLightbox source={image} onClose={closeImage} /> : null}
    </MermaidStreamingContext.Provider>
  );
  return <MarkdownRendererFrame imageSources={imageSources}>{content}</MarkdownRendererFrame>;
});
