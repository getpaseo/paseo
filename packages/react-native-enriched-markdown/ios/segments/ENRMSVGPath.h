#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

#ifdef __cplusplus
extern "C" {
#endif

// Parse an SVG path `d` string into a CGPath. Supports the M/L/H/V/C/S/Q/T/A/Z
// command set (absolute and relative), which covers the @primer/octicons glyphs
// used for admonition headers. Elliptical arcs are approximated with cubic
// beziers. Returns NULL on empty/invalid input. Caller owns the returned path
// (CGPathRelease). CoreGraphics is used so the same code renders on iOS and macOS.
CGPathRef _Nullable ENRMCreateCGPathFromSVGPath(NSString *pathData) CF_RETURNS_RETAINED;

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
