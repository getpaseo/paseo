#pragma once

#include <TargetConditionals.h>

// RCTUIKit.h is react-native-macos only. On iOS we import UIKit and define the aliases ourselves.
#if !TARGET_OS_OSX
#import <UIKit/UIKit.h>
#define RCTUIColor UIColor
#define RCTUIImage UIImage
#define RCTUIView UIView
#define RCTUIScrollView UIScrollView
#define RCTUIGraphicsImageRenderer UIGraphicsImageRenderer
#define RCTUIGraphicsImageRendererContext UIGraphicsImageRendererContext
#define RCTUIGraphicsImageRendererFormat UIGraphicsImageRendererFormat
#define ENRMPlatformTextView UITextView
#define ENRMTapRecognizer UITapGestureRecognizer

// Inline helpers that RCTUIKit.h normally provides on iOS.
static inline UIBezierPath *UIBezierPathWithRoundedRect(CGRect rect, CGFloat cornerRadius)
{
  return [UIBezierPath bezierPathWithRoundedRect:rect cornerRadius:cornerRadius];
}
static inline void UIBezierPathAppendPath(UIBezierPath *path, UIBezierPath *appendPath)
{
  [path appendPath:appendPath];
}
static inline CGFloat UIFontLineHeight(UIFont *font)
{
  return font.lineHeight;
}
#else
#import <React/RCTTextUIKit.h>
#import <React/RCTUIKit.h>
#import <React/RCTUITextView.h>
#define ENRMPlatformTextView RCTUITextView
#define ENRMTapRecognizer NSClickGestureRecognizer
#endif

/// Value for `usesFontLeading` on every NSLayoutManager that draws or
/// measures markdown. NSLayoutManager defaults to YES, which adds each font's
/// built-in leading on top of the paragraph line height. React Native turns it
/// off for Text layout, and drawing and measuring must agree, or the reported
/// height and the on-screen layout drift apart. Fonts pulled in by glyph
/// fallback make this visible: Geeza Pro (Arabic) has nonzero leading, so with
/// YES every Arabic line measures taller than it renders.
/// https://github.com/react/react-native/blob/v0.86.2/packages/react-native/ReactCommon/react/renderer/textlayoutmanager/platform/ios/react/renderer/textlayoutmanager/RCTTextLayoutManager.mm#L237
static const BOOL ENRMLayoutManagerUsesFontLeading = NO;

/// On iOS, explicitly sets opaque=NO — without it the renderer produces an opaque backing,
/// breaking transparent backgrounds. macOS handles transparency by default.
static inline RCTUIGraphicsImageRenderer *ImageRendererForSize(CGSize size)
{
#if !TARGET_OS_OSX
  RCTUIGraphicsImageRendererFormat *format = [RCTUIGraphicsImageRendererFormat preferredFormat];
  format.opaque = NO;
  return [[RCTUIGraphicsImageRenderer alloc] initWithSize:size format:format];
#else
  return [[RCTUIGraphicsImageRenderer alloc] initWithSize:size];
#endif
}

/// NSBezierPath uses NS-prefixed enum values; UIBezierPath uses kCG-prefixed constants.
static inline void BezierPathSetRoundStyle(UIBezierPath *path)
{
#if !TARGET_OS_OSX
  path.lineCapStyle = kCGLineCapRound;
  path.lineJoinStyle = kCGLineJoinRound;
#else
  path.lineCapStyle = NSLineCapStyleRound;
  path.lineJoinStyle = NSLineJoinStyleRound;
#endif
}

/// Cross-platform line segment: NSBezierPath uses lineToPoint: instead of addLineToPoint:.
static inline void BezierPathAddLine(UIBezierPath *path, CGPoint point)
{
#if !TARGET_OS_OSX
  [path addLineToPoint:point];
#else
  [path lineToPoint:point];
#endif
}

/// Cross-platform quad-curve: NSBezierPath lacks addQuadCurveToPoint:, so we approximate
/// with a cubic Bezier using the standard quadratic-to-cubic conversion.
static inline void BezierPathAddQuadCurve(UIBezierPath *path, CGPoint end, CGPoint control)
{
#if !TARGET_OS_OSX
  [path addQuadCurveToPoint:end controlPoint:control];
#else
  CGPoint start = [path currentPoint];
  [path curveToPoint:end
       controlPoint1:CGPointMake(start.x + 2.0 / 3.0 * (control.x - start.x),
                                 start.y + 2.0 / 3.0 * (control.y - start.y))
       controlPoint2:CGPointMake(end.x + 2.0 / 3.0 * (control.x - end.x), end.y + 2.0 / 3.0 * (control.y - end.y))];
#endif
}

/// Cross-platform IME composition check: UITextView uses markedTextRange (nullable UITextRange);
/// NSTextView uses hasMarkedText (BOOL).
static inline BOOL ENRMHasMarkedText(ENRMPlatformTextView *textView)
{
#if !TARGET_OS_OSX
  return textView.markedTextRange != nil;
#else
  return textView.hasMarkedText;
#endif
}

/// Cross-platform plain text read: UITextView uses .text; NSTextView uses .string.
static inline NSString *ENRMGetPlainText(ENRMPlatformTextView *textView)
{
#if !TARGET_OS_OSX
  return textView.text;
#else
  return textView.string;
#endif
}

/// Cross-platform plain text write: UITextView uses .text setter; NSTextView uses setString:.
static inline void ENRMSetPlainText(ENRMPlatformTextView *textView, NSString *text)
{
#if !TARGET_OS_OSX
  textView.text = text;
#else
  [textView setString:text];
#endif
}

/// Cross-platform attributed text read: NSTextView exposes content via textStorage;
/// UITextView exposes it via attributedText.
static inline NSAttributedString *ENRMGetAttributedText(ENRMPlatformTextView *textView)
{
#if !TARGET_OS_OSX
  return textView.attributedText;
#else
  return textView.textStorage;
#endif
}

/// Cross-platform attributed text write: NSTextView uses textStorage setAttributedString:;
/// UITextView uses the attributedText property setter.
static inline void ENRMSetAttributedText(ENRMPlatformTextView *textView, NSAttributedString *text)
{
#if !TARGET_OS_OSX
  textView.attributedText = text;
#else
  [textView.textStorage setAttributedString:text];
#endif
}

/// Cross-platform text replacement at a given range.
/// iOS uses UITextInput protocol methods; macOS uses NSTextView's insertText:replacementRange:.
static inline void ENRMReplaceTextInRange(ENRMPlatformTextView *textView, NSString *text, NSRange range)
{
#if !TARGET_OS_OSX
  UITextPosition *start = [textView positionFromPosition:textView.beginningOfDocument offset:(NSInteger)range.location];
  UITextPosition *end = [textView positionFromPosition:textView.beginningOfDocument
                                                offset:(NSInteger)NSMaxRange(range)];
  [textView replaceRange:[textView textRangeFromPosition:start toPosition:end] withText:text];
#else
  [textView insertText:text replacementRange:range];
#endif
}

/// Cross-platform content size update after measurement.
/// iOS UITextView has a settable contentSize; macOS NSTextView does not.
static inline void ENRMSetContentSize(ENRMPlatformTextView *textView, CGSize size)
{
#if !TARGET_OS_OSX
  textView.contentSize = size;
#endif
}

/// Returns YES when the user has asked the system to minimise motion.
/// iOS: UIAccessibilityIsReduceMotionEnabled.
/// macOS: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion.
/// Always NO on platforms where the API is unavailable.
static inline BOOL ENRMShouldReduceMotion(void)
{
#if !TARGET_OS_OSX
  return UIAccessibilityIsReduceMotionEnabled();
#else
  if (@available(macOS 10.12, *)) {
    return NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
  }
  return NO;
#endif
}

/// Sets default typing attributes on the text view.
/// On macOS, RCTUITextView overrides setTypingAttributes: to use defaultTextAttributes,
/// so we must set that property as well.
static inline void ENRMSetDefaultTypingAttributes(ENRMPlatformTextView *textView, NSDictionary *attrs)
{
#if TARGET_OS_OSX
  textView.defaultTextAttributes = attrs;
#endif
  textView.typingAttributes = attrs;
}

/// Applies shared configuration to a text view used for markdown input editing.
/// Handles platform differences: scroll indicators, text container insets,
/// drawsBackground (macOS). Sets editable=YES, scrollEnabled=YES.
static inline void ENRMConfigureMarkdownTextInputTextView(ENRMPlatformTextView *textView)
{
  textView.font = [UIFont systemFontOfSize:16.0];
  textView.backgroundColor = [RCTUIColor clearColor];
  textView.editable = YES;
#if !TARGET_OS_OSX
  textView.scrollEnabled = YES;
  textView.showsVerticalScrollIndicator = NO;
  textView.showsHorizontalScrollIndicator = NO;
  textView.textContainerInset = UIEdgeInsetsZero;
#else
  textView.textContainerInsets = UIEdgeInsetsZero;
  textView.drawsBackground = NO;
#endif
  textView.textContainer.lineFragmentPadding = 0;
}

/// Cross-platform cursor color: iOS uses tintColor; macOS uses insertionPointColor.
static inline void ENRMSetCursorColor(ENRMPlatformTextView *textView, RCTUIColor *color)
{
#if !TARGET_OS_OSX
  textView.tintColor = color;
#else
  textView.insertionPointColor = color;
#endif
}

/// Cross-platform selection color: iOS uses tintColor (also affects the caret
/// and selection handles); macOS sets the selection background via
/// `selectedTextAttributes`. Pass `nil` to restore the system default.
static inline void ENRMSetSelectionColor(ENRMPlatformTextView *textView, RCTUIColor *color)
{
#if !TARGET_OS_OSX
  textView.tintColor = color;
#else
  RCTUIColor *resolved = color ?: [NSColor selectedTextBackgroundColor];
  textView.selectedTextAttributes = @{NSBackgroundColorAttributeName : resolved};
#endif
}

/// Cross-platform focus: iOS uses becomeFirstResponder;
/// macOS uses makeFirstResponder: on the window.
static inline void ENRMFocusTextView(ENRMPlatformTextView *textView)
{
#if !TARGET_OS_OSX
  [textView becomeFirstResponder];
#else
  [textView.window makeFirstResponder:textView];
#endif
}

/// Cross-platform blur: iOS uses resignFirstResponder;
/// macOS clears first responder via the window.
static inline void ENRMBlurTextView(ENRMPlatformTextView *textView)
{
#if !TARGET_OS_OSX
  [textView resignFirstResponder];
#else
  [textView.window makeFirstResponder:nil];
#endif
}

/// Applies shared configuration to a text view used for markdown rendering.
/// Handles platform differences: scroll indicators, text container insets,
/// drawsBackground (macOS), accessibilityElementsHidden (iOS).
static inline void ENRMConfigureMarkdownTextView(ENRMPlatformTextView *textView)
{
  textView.font = [UIFont systemFontOfSize:16.0];
  textView.backgroundColor = [RCTUIColor clearColor];
  textView.textColor = [RCTUIColor blackColor];
  textView.editable = NO;
  textView.scrollEnabled = NO;
#if !TARGET_OS_OSX
  textView.showsVerticalScrollIndicator = NO;
  textView.showsHorizontalScrollIndicator = NO;
  textView.textContainerInset = UIEdgeInsetsZero;
#else
  textView.textContainerInsets = UIEdgeInsetsZero;
  textView.drawsBackground = NO;
#endif
  textView.textContainer.lineFragmentPadding = 0;
  textView.layoutManager.usesFontLeading = ENRMLayoutManagerUsesFontLeading;
  textView.linkTextAttributes = @{};
  textView.selectable = YES;
#if !TARGET_OS_OSX
  textView.accessibilityElementsHidden = YES;
#endif
}

/// Result of a text layout measurement pass.
typedef struct {
  CGRect usedRect;
  CGRect extraLineFragmentRect;
} ENRMTextLayoutResult;

/// Measures text layout in a text view for a given width.
/// On macOS, temporarily disables widthTracksTextView so the container width
/// can be set directly without being overridden by the view's frame.
static inline ENRMTextLayoutResult ENRMMeasureTextLayout(ENRMPlatformTextView *textView, CGFloat maxWidth)
{
#if TARGET_OS_OSX
  textView.textContainer.widthTracksTextView = NO;
#endif
  textView.textContainer.size = CGSizeMake(maxWidth, CGFLOAT_MAX);
  [textView.layoutManager ensureLayoutForTextContainer:textView.textContainer];
  ENRMTextLayoutResult result;
  result.usedRect = [textView.layoutManager usedRectForTextContainer:textView.textContainer];
  result.extraLineFragmentRect = textView.layoutManager.extraLineFragmentRect;
#if TARGET_OS_OSX
  textView.textContainer.widthTracksTextView = YES;
#endif
  return result;
}

/// Cross-platform display refresh: UIView requires layoutIfNeeded before setNeedsDisplay
/// to flush pending layout before the redraw; NSView takes a BOOL argument.
/// Implemented as a macro to avoid Objective-C++ implicit pointer conversion issues in .mm files.
#if !TARGET_OS_OSX
#define ENRMSetNeedsDisplay(view)                                                                                      \
  do {                                                                                                                 \
    [(view) layoutIfNeeded];                                                                                           \
    [(view) setNeedsDisplay];                                                                                          \
  } while (0)
#else
#define ENRMSetNeedsDisplay(view) [(view) setNeedsDisplay:YES]
#endif

/// Invalidates the text container, re-lays out any existing content, and
/// triggers a redraw.  On iOS also resets contentOffset to zero.
/// Does NOT touch the text view's frame — callers that need to reposition
/// the view should set the frame themselves before calling this.
static inline void ENRMRefreshTextViewLayout(ENRMPlatformTextView *textView)
{
#if !TARGET_OS_OSX
  textView.contentOffset = CGPointZero;
#endif
  textView.textContainer.size = CGSizeMake(textView.bounds.size.width, CGFLOAT_MAX);
  NSUInteger textLength = ENRMGetAttributedText(textView).length;
  if (textLength > 0) {
    [textView.layoutManager invalidateLayoutForCharacterRange:NSMakeRange(0, textLength) actualCharacterRange:NULL];
    [textView.layoutManager ensureLayoutForTextContainer:textView.textContainer];
  }
  ENRMSetNeedsDisplay(textView);
}

/// Refreshes a text view's layout and display after it is attached to a window.
/// Sets the frame and text container to the given bounds, invalidates layout for
/// any existing content, then triggers a redraw.
static inline void ENRMRefreshTextViewAfterWindowAttach(ENRMPlatformTextView *textView, CGRect bounds)
{
  textView.frame = bounds;
  ENRMRefreshTextViewLayout(textView);
}

/// Cross-platform text deselection: UITextView uses selectedTextRange (nullable);
/// NSTextView uses selectedRange (length-based).
static inline void ENRMClearSelection(ENRMPlatformTextView *textView)
{
#if !TARGET_OS_OSX
  if (textView.selectedTextRange != nil) {
    textView.selectedTextRange = nil;
  }
#else
  if (textView.selectedRange.length > 0) {
    textView.selectedRange = NSMakeRange(0, 0);
  }
#endif
}

// ── Placeholder label abstraction ──────────────────────────────────────────────

#if !TARGET_OS_OSX
typedef UILabel ENRMPlaceholderLabel;
#else
typedef NSTextField ENRMPlaceholderLabel;
#endif

/// Creates a placeholder label configured for use inside an ENRMPlatformTextView.
/// On iOS: UILabel with multiline, placeholderTextColor, auto-layout pinned to
/// textContainerInset and lineFragmentPadding.
/// On macOS: borderless, non-editable NSTextField pinned to the text view origin.
static inline ENRMPlaceholderLabel *ENRMCreatePlaceholderLabel(ENRMPlatformTextView *textView, UIFont *font)
{
#if !TARGET_OS_OSX
  UILabel *label = [[UILabel alloc] init];
  label.numberOfLines = 0;
  label.textColor = [UIColor placeholderTextColor];
  label.font = font;
  label.translatesAutoresizingMaskIntoConstraints = NO;
  [textView addSubview:label];
  [NSLayoutConstraint activateConstraints:@[
    [label.topAnchor constraintEqualToAnchor:textView.topAnchor constant:textView.textContainerInset.top],
    [label.leadingAnchor constraintEqualToAnchor:textView.leadingAnchor
                                        constant:textView.textContainer.lineFragmentPadding],
    [label.trailingAnchor constraintEqualToAnchor:textView.trailingAnchor
                                         constant:-textView.textContainer.lineFragmentPadding],
  ]];
  return label;
#else
  NSTextField *label = [[NSTextField alloc] initWithFrame:CGRectZero];
  label.bordered = NO;
  label.editable = NO;
  label.selectable = NO;
  label.drawsBackground = NO;
  label.textColor = [NSColor placeholderTextColor];
  label.font = font;
  label.translatesAutoresizingMaskIntoConstraints = NO;
  [textView addSubview:label];
  [NSLayoutConstraint activateConstraints:@[
    [label.topAnchor constraintEqualToAnchor:textView.topAnchor],
    [label.leadingAnchor constraintEqualToAnchor:textView.leadingAnchor],
  ]];
  return label;
#endif
}

/// Cross-platform placeholder attributed text setter.
static inline void ENRMSetPlaceholderAttributedText(ENRMPlaceholderLabel *label, NSAttributedString *text)
{
#if !TARGET_OS_OSX
  label.attributedText = text;
#else
  label.attributedStringValue = text;
#endif
}
