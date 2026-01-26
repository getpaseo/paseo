// This file exists for TypeScript resolution.
// The actual implementations are in:
// - draggable-list.native.tsx (iOS/Android)
// - draggable-list.web.tsx (Web)
// Metro's platform-specific extensions will pick the right one at runtime.

export * from "./draggable-list.native";
