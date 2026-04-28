// This file exists for TypeScript resolution.
// The actual implementations are in:
// - monaco-diff-editor.native.tsx (iOS/Android)
// - monaco-diff-editor.web.tsx (Web/Electron)
// Metro's platform-specific extensions will pick the right one at runtime.

export * from "./monaco-diff-editor.native";
