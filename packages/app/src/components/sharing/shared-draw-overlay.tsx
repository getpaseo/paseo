// Platform-resolved: see shared-draw-overlay.web.tsx / shared-draw-overlay.native.tsx.
// This barrel exists so TypeScript can resolve the import; Metro picks the
// platform-specific file at bundle time.
export { SharedDrawOverlay } from "./shared-draw-overlay.web";
