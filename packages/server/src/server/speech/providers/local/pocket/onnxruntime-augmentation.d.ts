// Type augmentation for onnxruntime-node to include runtime properties
// not exposed in the official type definitions

import type * as ort from "onnxruntime-node";

declare module "onnxruntime-node" {
  interface InferenceSession {
    /** Input tensor names (available at runtime but not in types) */
    readonly inputNames: string[];
    /** Output tensor names (available at runtime but not in types) */
    readonly outputNames?: string[];
    /** Input metadata for shape/type info (available at runtime but not in types) */
    readonly inputMetadata?: unknown;
  }
}
