#pragma once
#import <objc/runtime.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Runtime keys for associated objects.
 * These keys are used to store references on UIKit objects via objc_setAssociatedObject.
 */

// Key for storing UITextView on NSTextContainer
// Used by attachments to retrieve the text view when needed
extern void *kTextViewKey;

// Key for storing StyleConfig on NSLayoutManager
// Used by TextViewLayoutManager to access configuration
extern void *kStyleConfigKey;

// Key for storing CodeBackground instance on NSLayoutManager
// Used by TextViewLayoutManager for code background drawing
extern void *kCodeBackgroundKey;

// Key for storing BlockquoteBorder instance on NSLayoutManager
// Used by TextViewLayoutManager for blockquote border drawing
extern void *kBlockquoteBorderKey;

// Key for storing ListMarkerDrawer instance on NSLayoutManager
// Used by TextViewLayoutManager for list marker drawing
extern void *kListMarkerDrawerKey;

// Key for storing CodeBlockBackground instance on NSLayoutManager
// Used by TextViewLayoutManager for code block background drawing
extern void *kCodeBlockBackgroundKey;

// Custom attribute keys for markdown type tracking (used for Copy Markdown)
extern NSString *const MarkdownTypeAttributeName;

NS_ASSUME_NONNULL_END
