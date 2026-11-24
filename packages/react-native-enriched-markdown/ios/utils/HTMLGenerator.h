#pragma once
#import "ENRMUIKit.h"
#import <Foundation/Foundation.h>

@class StyleConfig;

NS_ASSUME_NONNULL_BEGIN

#ifdef __cplusplus
extern "C" {
#endif

/// Generates semantic HTML with inline styles (email-client compatible).
/// Document direction is read from the first paragraph style of `attributedString`.
NSString *_Nullable generateHTML(NSAttributedString *attributedString, StyleConfig *styleConfig);

/// Generates an HTML `<table>` with inline styles from rows of cell dictionaries.
/// Table direction is read from the first paragraph style of the first non-empty cell.
NSString *_Nullable generateTableHTML(NSArray<NSArray<NSDictionary *> *> *rows, StyleConfig *styleConfig);

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
