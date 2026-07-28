import type { z } from "zod";

import {
  generateStructuredAgentResponseWithFallback,
  type StructuredAgentGenerationWithFallbackOptions,
  type StructuredGenerationLogger,
} from "./agent-response-loop.js";
import type { StructuredGenerationDaemonConfig } from "./structured-generation-providers.js";
import {
  generateMetadataOpenAIStructured,
  isMetadataCustomEndpointReady,
} from "./metadata-openai-client.js";

export interface GenerateStructuredMetadataResponseOptions<
  T,
> extends StructuredAgentGenerationWithFallbackOptions<T> {
  daemonConfig?: StructuredGenerationDaemonConfig | null;
  generateCustom?: typeof generateMetadataOpenAIStructured;
  generateWithAgents?: typeof generateStructuredAgentResponseWithFallback;
}

export async function generateStructuredMetadataResponse<T>(
  options: GenerateStructuredMetadataResponseOptions<T>,
): Promise<T> {
  const {
    daemonConfig,
    generateCustom = generateMetadataOpenAIStructured,
    generateWithAgents = generateStructuredAgentResponseWithFallback,
    logger,
    schema,
    schemaName,
    prompt,
    ...agentOptions
  } = options;

  const customEndpoint = daemonConfig?.metadataGeneration?.customEndpoint;
  if (isMetadataCustomEndpointReady(customEndpoint) && isZodSchema(schema)) {
    try {
      return await generateCustom({
        baseUrl: customEndpoint?.baseUrl ?? "",
        apiKey: customEndpoint?.apiKey,
        model: customEndpoint?.model ?? "",
        prompt,
        schema,
        schemaName: schemaName ?? "Response",
      });
    } catch (error) {
      logger?.warn?.(
        { err: error, schemaName },
        "Metadata custom endpoint failed; falling back to agents",
      );
    }
  }

  return generateWithAgents({
    ...agentOptions,
    prompt,
    schema,
    schemaName,
    logger,
  });
}

function isZodSchema(value: unknown): value is z.ZodType {
  return typeof (value as { safeParse?: unknown } | undefined)?.safeParse === "function";
}

// Ensure StructuredGenerationLogger is referenced for type-only consumers of warn.
export type MetadataGenerationLogger = StructuredGenerationLogger;
