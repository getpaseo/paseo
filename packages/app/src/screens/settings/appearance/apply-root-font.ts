// Native (and default) no-op: React Native has no global font cascade, so the
// interface font applies only where components read theme.fontFamily.ui. The web
// build (apply-root-font.web.ts) overrides this to apply it app-wide.
export function applyRootUiFont(_uiFontStack: string): void {}
