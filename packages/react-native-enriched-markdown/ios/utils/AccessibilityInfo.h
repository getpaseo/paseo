#import <Foundation/Foundation.h>

@class RenderContext;

NS_ASSUME_NONNULL_BEGIN

/**
 * Container for accessibility-related data extracted from RenderContext.
 * Used by MarkdownAccessibilityElementBuilder to build VoiceOver elements.
 */
@interface AccessibilityInfo : NSObject

// Headings
@property (nonatomic, copy, readonly) NSArray<NSValue *> *headingRanges;
@property (nonatomic, copy, readonly) NSArray<NSNumber *> *headingLevels;

// Links
@property (nonatomic, copy, readonly) NSArray<NSValue *> *linkRanges;
@property (nonatomic, copy, readonly) NSArray<NSString *> *linkURLs;

// Images
@property (nonatomic, copy, readonly) NSArray<NSValue *> *imageRanges;
@property (nonatomic, copy, readonly) NSArray<NSString *> *imageAltTexts;

// List items
@property (nonatomic, copy, readonly) NSArray<NSValue *> *listItemRanges;
@property (nonatomic, copy, readonly) NSArray<NSNumber *> *listItemPositions;
@property (nonatomic, copy, readonly) NSArray<NSNumber *> *listItemDepths;
@property (nonatomic, copy, readonly) NSArray<NSNumber *> *listItemOrdered; // YES = ordered, NO = bullet

+ (instancetype)infoFromContext:(RenderContext *)context;

@end

NS_ASSUME_NONNULL_END
