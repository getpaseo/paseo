#pragma once

#import "ENRMUIKit.h"

@class EnrichedMarkdownTextInput;

NS_ASSUME_NONNULL_BEGIN

extern NSString *const kENRMMarkdownPasteboardType;

@interface ENRMInputTextView : ENRMPlatformTextView
@property (nonatomic, weak, nullable) EnrichedMarkdownTextInput *markdownTextInput;
@end

NS_ASSUME_NONNULL_END
