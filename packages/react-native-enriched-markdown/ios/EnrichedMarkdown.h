#import "ENRMUIKit.h"
#import "StyleConfig.h"
#import <React/RCTViewComponentView.h>

#ifndef EnrichedMarkdownNativeComponent_h
#define EnrichedMarkdownNativeComponent_h

NS_ASSUME_NONNULL_BEGIN

@interface EnrichedMarkdown : RCTViewComponentView
@property (nonatomic, strong) StyleConfig *config;
- (CGSize)measureSize:(CGFloat)maxWidth;
- (void)renderMarkdownSynchronously:(NSString *)markdownString;
- (BOOL)hasRenderedMarkdown:(NSString *)markdown;
- (BOOL)hasRenderedWithStyleFingerprint:(size_t)fingerprint;

/// Size last committed by Fabric via `updateLayoutMetrics:`, readable from
/// any thread without blocking (issue #550: the shadow-node measure path must
/// never wait on the main thread, and reading `bounds` off-main is unsafe).
/// Backed by a single lock-free atomic, so the pair can't tear. Returns
/// CGSizeZero until the first layout is committed.
- (CGSize)lastCommittedLayoutSize;
@end

NS_ASSUME_NONNULL_END

#endif
