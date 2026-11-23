#pragma once
#import "ENRMContextMenuTextView+macOS.h"
#import "ENRMSpoilerCapable.h"
#import "ENRMSpoilerOverlayView.h"
#import "ENRMUIKit.h"
#import "LinkTapUtils.h"
#import "StyleConfig.h"

@class RenderContext;
@class AccessibilityInfo;
@class ENRMAccessibilityLabels;
@class ENRMSpoilerOverlayManager;

NS_ASSUME_NONNULL_BEGIN

@interface EnrichedMarkdownInternalText : RCTUIView <ENRMSpoilerCapable>

- (instancetype)initWithConfig:(StyleConfig *)config;

- (void)applyAttributedText:(NSMutableAttributedString *)text context:(RenderContext *)context;

- (CGFloat)measureHeight:(CGFloat)maxWidth;
- (CGSize)measureSize:(CGFloat)maxWidth;

@property (nonatomic, readonly) ENRMPlatformTextView *textView;
@property (nonatomic, readonly) ENRMSpoilerOverlayManager *spoilerManager;
@property (nonatomic) ENRMSpoilerOverlay spoilerOverlay;

@property (nonatomic, strong, nullable) AccessibilityInfo *accessibilityInfo;
@property (nonatomic, strong, nullable) ENRMAccessibilityLabels *accessibilityLabels;

@property (nonatomic, strong) StyleConfig *config;

@property (nonatomic, assign) BOOL allowTrailingMargin;

@property (nonatomic, assign) CGFloat lastElementMarginBottom;

#if TARGET_OS_OSX
- (void)setContextMenuProvider:(ENRMContextMenuProvider)provider;
#endif

@end

NS_ASSUME_NONNULL_END
