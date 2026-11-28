#import "ENRMUIKit.h"
#import <Foundation/Foundation.h>

@class BlockStyle;
@class RenderContext;

NS_ASSUME_NONNULL_BEGIN

#ifdef __cplusplus
extern "C" {
#endif

/** Returns a cached UIFont from BlockStyle properties via RenderContext. */
extern UIFont *cachedFontFromBlockStyle(BlockStyle *blockStyle, RenderContext *context);

/** Returns the font scale multiplier, capped by maxFontSizeMultiplier.
 *  Uses React Native's RCTFontSizeMultiplier() internally.
 *  @param maxFontSizeMultiplier Values >= 1.0 cap the result, < 1.0 means no cap. */
extern CGFloat RCTFontSizeMultiplierWithMax(CGFloat maxFontSizeMultiplier);

/** Converts a CSS-style font weight string to a UIFontWeight constant.
 *  Mirrors React Native's RCTFont table: "100"/"ultralight" through
 *  "900"/"black", plus the "normal"/"regular"/"bold"/etc. aliases.
 *  Returns UIFontWeightRegular for unrecognised or nil input. */
extern UIFontWeight ENRMFontWeightFromString(NSString *_Nullable weightString);

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
