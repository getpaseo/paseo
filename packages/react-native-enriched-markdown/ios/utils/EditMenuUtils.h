#pragma once
#import "ENRMUIKit.h"
#import <Foundation/Foundation.h>

@class StyleConfig;

NS_ASSUME_NONNULL_BEGIN

typedef struct {
  BOOL copyAsMarkdown;
  BOOL copyImageURL;
  // The owner must keep these strings alive for the duration of the call (the
  // view holds them in strong ivars).
  __unsafe_unretained NSString *_Nullable copyLabel;
  __unsafe_unretained NSString *_Nullable copyAsMarkdownLabel;
  __unsafe_unretained NSString *_Nullable copyImageUrlLabel;
  __unsafe_unretained NSString *_Nullable copyImageUrlsLabel;
  __unsafe_unretained NSArray<NSString *> *_Nullable copyImageUrlPluralTemplates;
} ENRMSelectionMenuConfig;

/// Resolves the "Copy Image URL(s)" menu title for a given image count.
/// Uses the precomputed plural templates (indexed by count, 0..100) when present;
/// counts > 100 use the "other" form (copyImageUrlsLabel). Otherwise the
/// singular/`{count}` templates. All labels are resolved JS-side.
static inline NSString *ENRMResolveImageURLsTitle(ENRMSelectionMenuConfig config, NSUInteger count)
{
  NSArray<NSString *> *templates = config.copyImageUrlPluralTemplates;
  NSString *titleTemplate;
  if (count < templates.count) {
    titleTemplate = templates[count];
  } else if (count == 1) {
    titleTemplate = config.copyImageUrlLabel;
  } else {
    titleTemplate = config.copyImageUrlsLabel;
  }
  return [titleTemplate stringByReplacingOccurrencesOfString:@"{count}" withString:[@(count) stringValue]];
}

#ifdef __cplusplus

/// Strong owners for the label strings in ENRMSelectionMenuConfig.
struct ENRMSelectionMenuLabels {
  NSString *copyLabel = nil;
  NSString *copyAsMarkdownLabel = nil;
  NSString *copyImageUrlLabel = nil;
  NSString *copyImageUrlsLabel = nil;
  NSArray<NSString *> *copyImageUrlPluralTemplates = nil;
};

/// Converts a codegen SelectionMenuConfig struct into strong NSString labels.
template <typename T> static inline ENRMSelectionMenuLabels ENRMParseSelectionMenuLabels(const T &src)
{
  NSMutableArray<NSString *> *templates = [NSMutableArray array];
  for (const auto &s : src.copyImageUrlPluralTemplates) {
    [templates addObject:[[NSString alloc] initWithUTF8String:s.c_str()]];
  }
  return {
      [[NSString alloc] initWithUTF8String:src.copyLabel.c_str()],
      [[NSString alloc] initWithUTF8String:src.copyAsMarkdownLabel.c_str()],
      [[NSString alloc] initWithUTF8String:src.copyImageUrlLabel.c_str()],
      [[NSString alloc] initWithUTF8String:src.copyImageUrlsLabel.c_str()],
      templates,
  };
}

/// Builds an ENRMSelectionMenuConfig from pre-parsed labels and boolean flags.
static inline ENRMSelectionMenuConfig ENRMBuildSelectionMenuConfig(const ENRMSelectionMenuLabels &labels,
                                                                   bool copyAsMarkdown, bool copyImageUrl)
{
  return (ENRMSelectionMenuConfig){
      .copyAsMarkdown = copyAsMarkdown,
      .copyImageURL = copyImageUrl,
      .copyLabel = labels.copyLabel,
      .copyAsMarkdownLabel = labels.copyAsMarkdownLabel,
      .copyImageUrlLabel = labels.copyImageUrlLabel,
      .copyImageUrlsLabel = labels.copyImageUrlsLabel,
      .copyImageUrlPluralTemplates = labels.copyImageUrlPluralTemplates,
  };
}

extern "C" {
#endif

#if !TARGET_OS_OSX
// TODO: Remove API_AVAILABLE(ios(16.0)) guard when the minimum iOS deployment target in RN is bumped to 16.
// TODO: selectionMenuConfig labels do NOT reach the system "Save to Camera Roll /
// Copy" sheet shown when long-pressing an NSTextAttachment image — UIKit owns
// that sheet end-to-end. Hooking UIContextMenuInteraction on image regions and
// returning a custom UIContextMenuConfiguration would let us relabel those items.
UIMenu *buildEditMenuForSelection(NSAttributedString *attributedText, NSRange range, NSString *_Nullable cachedMarkdown,
                                  StyleConfig *styleConfig, NSArray<UIMenuElement *> *suggestedActions,
                                  NSArray<UIAction *> *_Nullable customActions,
                                  ENRMSelectionMenuConfig selectionMenuConfig) API_AVAILABLE(ios(16.0));
#else
NSMenu *_Nullable buildEditMenuForSelection(NSAttributedString *attributedText, NSRange range,
                                            NSString *_Nullable cachedMarkdown, StyleConfig *styleConfig,
                                            NSArray *suggestedActions, NSArray<NSMenuItem *> *_Nullable customItems,
                                            ENRMSelectionMenuConfig selectionMenuConfig);
#endif

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
