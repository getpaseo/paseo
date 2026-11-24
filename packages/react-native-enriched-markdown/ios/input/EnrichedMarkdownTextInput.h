#import "ENRMUIKit.h"
#import <React/RCTViewComponentView.h>

#ifndef EnrichedMarkdownTextInput_h
#define EnrichedMarkdownTextInput_h

@class ENRMEditSession;

NS_ASSUME_NONNULL_BEGIN

@interface EnrichedMarkdownTextInput : RCTViewComponentView
@property (nonatomic, readonly) ENRMEditSession *editSession;
- (CGSize)measureSize:(CGFloat)maxWidth;
- (nullable NSString *)markdownForSelectedRange;
- (void)copyToClipboard;
- (void)pasteMarkdown:(NSString *)markdown;
- (void)replaceSelectedTextWith:(NSString *)text formattingRanges:(NSArray *)ranges;
- (void)scheduleRelayoutIfNeeded;
@end

NS_ASSUME_NONNULL_END

#endif
