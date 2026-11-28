#pragma once
#import "ENRMUIKit.h"
#import <Foundation/Foundation.h>

static const CGFloat kENRMMathFallbackDefaultFontSize = 16.0;

NS_ASSUME_NONNULL_BEGIN

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Builds the visible-source fallback for a RaTeX parse failure: the original
 * LaTeX source wrapped in its delimiters ($ inline, $$ block), typeset in body
 * style. A parse failure must never render as an invisible zero-size box —
 * the formula stays visible and copyable instead.
 */
NSAttributedString *ENRMMathFallbackString(NSString *_Nullable latex, NSString *delimiter, CGFloat fontSize,
                                           RCTUIColor *_Nullable color);

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
