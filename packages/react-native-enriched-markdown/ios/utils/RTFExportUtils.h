#pragma once
#import "ENRMUIKit.h"
#import <Foundation/Foundation.h>

@class StyleConfig;

NS_ASSUME_NONNULL_BEGIN

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Prepares NSAttributedString for RTF/RTFD export by adding backgrounds,
 * inserting text markers (>, •, 1.), and normalizing paragraph styles.
 */
NSAttributedString *prepareAttributedStringForRTFExport(NSAttributedString *attributedString,
                                                        StyleConfig *_Nullable styleConfig);

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
