import { Image } from "react-native";
import { isWeb } from "@/constants/platform";
import { useMemo, useEffect, useId } from "react";
import { useFetchQueries } from "@/data/query";
import { createAssistantImageFileAcquisition } from "@/assistant-image/file-acquisition";
import { persistAttachmentFromBytes, resolveAttachmentPreviewUrl } from "@/attachments/service";
import { assistantImagePreviews } from "@/assistant-image/image-cache";
import { resolveAssistantImageSource } from "@/utils/assistant-image-source";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { resolveMarkdownPreviewImageSource } from "./image-source";
import { prepareMarkdownSource } from "./source";
import { decodeMarkdownImage, getMarkdownImageStatus } from "./image-decoding";

export interface MarkdownImageContext {
  client?: Pick<DaemonClient, "readFile"> | null;
  workspaceRoot?: string;
  serverId?: string;
  filePath?: string;
}

export function useMarkdownSource(
  text: string,
  context: MarkdownImageContext,
  links: { commandNames?: ReadonlySet<string>; forgeReferencePattern?: string } = {},
) {
  const occurrenceKey = useId();
  const { commandNames, forgeReferencePattern } = links;
  const prepared = useMemo(
    () =>
      prepareMarkdownSource(text, context.workspaceRoot, {
        supportsSvg: isWeb,
        commandNames,
        forgeReferencePattern,
      }),
    [text, context.workspaceRoot, commandNames, forgeReferencePattern],
  );
  const sources = [...new Set(prepared.images.map((image) => image.source))];
  const acquisitions = sources.map((source) => {
    const resolved = resolveMarkdownPreviewImageSource({
      source,
      markdownPath: context.filePath ?? "",
      workspaceRoot: context.workspaceRoot,
    });
    return createAssistantImageFileAcquisition({
      port: context.client
        ? {
            readFile: (cwd, path) => context.client!.readFile(cwd, path),
            persist: persistAttachmentFromBytes,
          }
        : null,
      resolution: resolved
        ? resolveAssistantImageSource({ source: resolved, workspaceRoot: context.workspaceRoot })
        : null,
      serverId: context.serverId,
      occurrenceKey,
      unavailableMessage: "Image unavailable",
    });
  });
  const results = useFetchQueries(
    acquisitions.map((acquisition, index) => ({
      queryKey: ["markdownImage", acquisition?.key ?? sources[index]],
      enabled: acquisition !== null,
      immutableWhen: () => true,
      dataShape: "value",
      gcTime: 0,
      queryFn: async () => {
        if (!acquisition) throw new Error("No image acquisition");
        return assistantImagePreviews.acquire(acquisition.key, async () => {
          const attachment = await acquisition.locate();
          const uri = await resolveAttachmentPreviewUrl(attachment);
          return { attachment, uri };
        });
      },
    })),
  );
  useEffect(() => {
    const releases = results.flatMap((result, index) => {
      const acquisition = acquisitions[index];
      if (!result.data || !acquisition) return [];
      const value = result.data;
      return [assistantImagePreviews.acquireRetained(acquisition.key, async () => value).release];
    });
    return () => releases.forEach((release) => release());
  }, [results, acquisitions]);
  const resolved = new Map<string, string>();
  results.forEach((result, index) => {
    if (result.data) resolved.set(sources[index]!, result.data.uri);
  });
  const displayUrls = sources.map(
    (source) =>
      resolved.get(source) ?? (/^(https?:|data:|blob:)/i.test(source) ? source : undefined),
  );
  const decoded = useFetchQueries(
    displayUrls.map((uri, index) => ({
      queryKey: ["markdownImageDecode", occurrenceKey, uri ?? sources[index]],
      refetchOnReconnect: true,
      enabled: uri !== undefined,
      immutableWhen: () => true,
      dataShape: "value",
      gcTime: 0,
      queryFn: () => {
        if (!uri) throw new Error("No image URL to decode");
        return decodeMarkdownImage(uri, Image.getSize);
      },
    })),
  );
  const statuses = sources.map((_source, index) =>
    getMarkdownImageStatus({
      canAcquire: acquisitions[index] !== null,
      url: displayUrls[index],
      acquisitionFailed: results[index].isError,
      decodeFailed: decoded[index].isError,
      decoded: decoded[index].data === true,
    }),
  );
  const unavailableImages = new Set(
    sources.filter((_source, index) => statuses[index] === "unavailable"),
  );
  const pendingImages = new Set(sources.filter((_source, index) => statuses[index] === "pending"));
  return {
    markdown: prepared.render(resolved, unavailableImages, pendingImages),
    linkRecognition: prepared.linkRecognition,
    linkSource: prepared.linkSource,
    imageSources: Object.fromEntries([...resolved].map(([source, url]) => [url, source])),
  };
}
