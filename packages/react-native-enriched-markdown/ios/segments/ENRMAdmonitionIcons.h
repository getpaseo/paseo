#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

#ifdef __cplusplus
extern "C" {
#endif

// GitHub admonition/alert header assets shared with Android and web.
//
// The `d` path strings live in ENRMAdmonitionIcons.m and are taken verbatim from
// @primer/octicons (16x16 viewBox); they MUST stay byte-identical across:
//   - iOS:     this file
//   - Android: android/.../segments/AdmonitionIcons.kt
//   - Web:     src/web/renderers/admonitionIcons.ts
extern const CGFloat ENRMAdmonitionIconViewBox;

// CGPath for the octicon of the given admonition type ("note", "tip",
// "important", "warning", "caution"), in the 16x16 icon space. NULL for unknown
// types. The returned path is cached and owned by the module; do not release.
CGPathRef _Nullable ENRMAdmonitionIconPath(NSString *type);

// Capitalized header title for the type (e.g. "note" -> "Note").
NSString *ENRMAdmonitionTitle(NSString *type);

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
