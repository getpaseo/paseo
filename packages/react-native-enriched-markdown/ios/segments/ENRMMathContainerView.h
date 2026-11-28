#pragma once
#import "ENRMDynamicBlockProps.h"
#import "ENRMLatexErrorReporting.h"
#import "ENRMUIKit.h"
#import "StyleConfig.h"

@class ENRMAccessibilityLabels;

NS_ASSUME_NONNULL_BEGIN

@interface ENRMMathContainerView : RCTUIView <ENRMLatexErrorReporting>

- (instancetype)initWithConfig:(StyleConfig *)config;

- (void)applyLatex:(NSString *)latex;

- (CGFloat)measureHeight:(CGFloat)maxWidth;

/// View-free math-block height for shadow-node measurement (issue #550):
/// parses the LaTeX through the same RaTeX bridge `applyLatex:` uses and
/// applies the same padding math as `measureHeight:` — including the wrapped
/// source-fallback path when RaTeX cannot parse — without creating any view.
/// Runs on the calling thread. Like every member of this class, only
/// implemented when ENRICHED_MARKDOWN_MATH is on — guard call sites.
+ (CGFloat)measureHeightForLatex:(NSString *)latex config:(StyleConfig *)config maxWidth:(CGFloat)maxWidth;

@property (nonatomic, strong) StyleConfig *config;
@property (nonatomic, copy, readonly) NSString *cachedLatex;
@property (nonatomic, strong, nullable) ENRMAccessibilityLabels *accessibilityLabels;
@property (nonatomic, copy, nullable) ENRMLatexErrorHandler onLatexError;

// Shared, runtime-mutable block props (context-menu gate + copy labels) read live
// at menu-open. Set to the root's shared instance at creation. See
// ENRMDynamicBlockProps.
@property (nonatomic, strong) ENRMDynamicBlockProps *dynamicProps;

@end

NS_ASSUME_NONNULL_END
