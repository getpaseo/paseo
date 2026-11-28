#pragma once
#import "ENRMUIKit.h"

#if !TARGET_OS_OSX
@class LinkVariantConfig;

NS_ASSUME_NONNULL_BEGIN

/**
 * A link presented as a pill. Like image and inline-math attachments it is a
 * single U+FFFC in text storage, laid out and drawn by TextKit natively.
 * The link's own rendered text is kept here; ENRMLinkPillText.h puts it back
 * wherever text leaves the view (copy, export, accessibility).
 */
@interface ENRMLinkPillAttachment : NSTextAttachment
@property (nonatomic, readonly) CGFloat boxHeight;
/// The minimum line height the pill asks of the block that holds it (`pill.lineHeight`); 0 for none.
@property (nonatomic, assign) CGFloat lineHeight;
/// The text the pill shows.
@property (nonatomic, readonly) NSString *label;
/// Visible label, followed by the original link text when they differ.
@property (nonatomic, readonly) NSString *linkAccessibilityLabel;
@property (nonatomic, readonly) NSAttributedString *originalText;
/// The radius the pill's corners are drawn with.
@property (nonatomic, readonly) CGFloat cornerRadius;
/// Draws nothing while set. The text view sets it while the pill is lifted for its menu,
/// so that the lifted copy is the only one on screen.
@property (nonatomic, assign) BOOL lifted;
/// Called on the main thread when an asynchronously loaded icon settles. For hosts that draw the
/// string themselves (the table grid) and have no text view for the attachment to invalidate.
@property (nonatomic, copy, nullable) void (^onIconLoaded)(void);

/// `variant.pill` must be non-nil. `label`, `iconUri` and `iconTintColor` are already resolved (per-link content,
/// then variant default).
- (instancetype)initWithOriginalText:(NSAttributedString *)originalText
                             variant:(LinkVariantConfig *)variant
                               label:(nullable NSString *)label
                             iconUri:(nullable NSString *)iconUri
                       iconTintColor:(nullable UIColor *)iconTintColor
                                font:(nullable UIFont *)font
                      requestHeaders:(nullable NSDictionary<NSString *, NSString *> *)requestHeaders;

- (void)adoptFont:(nullable UIFont *)font;
@end

NS_ASSUME_NONNULL_END
#endif
