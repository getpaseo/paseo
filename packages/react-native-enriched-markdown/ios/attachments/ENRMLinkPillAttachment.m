#import "ENRMLinkPillAttachment.h"
#import "ENRMImageAttachment.h"
#import "ENRMImageDownloader.h"
#import "ENRMLinkPillIconCache.h"
#import "ENRMSpoilerTapUtils.h"
#import "RuntimeKeys.h"
#import "StyleConfig.h"
#import <objc/runtime.h>

#if !TARGET_OS_OSX

// The icon occupies a square of the label's font size plus a quarter of it as a gap.
static const CGFloat kIconSlotRatio = 1.25;

/// Everything that decides what a drawn pill looks like. Streaming re-renders create new
/// attachments for the same links on every update; keyed like this, they reuse the drawn image.
@interface ENRMLinkPillAppearance : NSObject
@property (nonatomic, strong) LinkVariantConfig *variant;
@property (nonatomic, copy) NSString *label;
@property (nonatomic, strong) UIFont *font;
@property (nonatomic, strong, nullable) UIImage *icon;
@property (nonatomic, strong, nullable) UIColor *iconTint;
@property (nonatomic, assign) BOOL reservesIconSlot;
@property (nonatomic, assign) CGSize size;
@property (nonatomic, assign) UIUserInterfaceStyle interfaceStyle;
@end

@implementation ENRMLinkPillAppearance
- (NSUInteger)hash
{
  return _label.hash ^ _font.hash ^ (NSUInteger)_variant ^ (NSUInteger)(_size.width * 31 + _size.height);
}

- (BOOL)isEqual:(id)object
{
  if (![object isKindOfClass:ENRMLinkPillAppearance.class])
    return NO;
  ENRMLinkPillAppearance *other = object;
  // The variant and icon are compared by identity: both objects live as long as the style and
  // the icon cache keep them, and this key retains them, so a match is never a recycled pointer.
  BOOL sameTint = _iconTint == other->_iconTint || [_iconTint isEqual:other->_iconTint];
  return _variant == other->_variant && _icon == other->_icon && sameTint &&
         _reservesIconSlot == other->_reservesIconSlot && _interfaceStyle == other->_interfaceStyle &&
         CGSizeEqualToSize(_size, other->_size) && [_font isEqual:other->_font] &&
         [_label isEqualToString:other->_label];
}
@end

/// Drawn pills, shared and bounded: the ones on screen are redrawn often, but a long document
/// holds thousands, each a bitmap of 100 KB or more, so pills must not each keep their own.
static NSCache<ENRMLinkPillAppearance *, UIImage *> *ENRMRenderedLinkPills(void)
{
  static NSCache<ENRMLinkPillAppearance *, UIImage *> *rendered;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    rendered = [NSCache new];
    rendered.countLimit = 256;
    rendered.totalCostLimit = 8 * 1024 * 1024;
  });
  return rendered;
}

static UIImage *ENRMClearLinkPillImage(void)
{
  static UIImage *clear;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat preferredFormat];
    format.opaque = NO;
    clear = [[[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(1, 1) format:format]
        imageWithActions:^(UIGraphicsImageRendererContext *context){}];
  });
  return clear;
}

/// Streaming renders the same links again on every update; their label widths do not change.
static CGFloat ENRMLinkPillLabelWidth(NSString *label, UIFont *font)
{
  static NSCache<NSString *, NSNumber *> *widths;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    widths = [NSCache new];
    widths.countLimit = 2048;
  });
  NSString *key = [NSString stringWithFormat:@"%@|%.2f|%@", font.fontName, font.pointSize, label];
  NSNumber *cached = [widths objectForKey:key];
  if (cached)
    return cached.doubleValue;
  CGFloat width = [label sizeWithAttributes:@{NSFontAttributeName : font}].width;
  [widths setObject:@(width) forKey:key];
  return width;
}

@implementation ENRMLinkPillAttachment {
  LinkVariantConfig *_variant;
  LinkPillConfig *_pill;
  UIFont *_font;
  UIImage *_icon;
  UIColor *_iconTint;
  // Space for the icon is held while a remote icon is still loading, so its arrival only needs a redraw.
  BOOL _reservesIconSlot;
  __weak NSTextContainer *_textContainer;
  CGFloat _labelWidth;
}

- (instancetype)initWithOriginalText:(NSAttributedString *)originalText
                             variant:(LinkVariantConfig *)variant
                               label:(NSString *)label
                             iconUri:(NSString *)iconUri
                       iconTintColor:(UIColor *)iconTintColor
                                font:(UIFont *)font
                      requestHeaders:(NSDictionary<NSString *, NSString *> *)requestHeaders
{
  self = [super initWithData:nil ofType:nil];
  if (self) {
    _variant = variant;
    _pill = variant.pill;
    _iconTint = iconTintColor;
    _originalText = [originalText copy];
    _font = font ?: [UIFont systemFontOfSize:16];
    // The pill is a single line; a label supplied by the app may still carry breaks.
    NSString *visible = label.length > 0 ? label : originalText.string;
    _label = [[visible componentsSeparatedByCharactersInSet:NSCharacterSet.newlineCharacterSet]
        componentsJoinedByString:@" "];
    [self resolveIcon:iconUri requestHeaders:requestHeaders];
  }
  return self;
}

- (void)resolveIcon:(NSString *)iconUri requestHeaders:(NSDictionary<NSString *, NSString *> *)requestHeaders
{
  if (iconUri.length == 0)
    return;
  _icon = ENRMLoadLinkPillIcon(iconUri) ?: ENRMCachedLinkPillIcon(iconUri, requestHeaders);
  _reservesIconSlot = _icon != nil;
  if (_icon || ENRMLinkPillIconDidFail(iconUri, requestHeaders))
    return;
  _reservesIconSlot = YES;
  __weak typeof(self) weakSelf = self;
  ENRMLoadLinkPillIconAsync(iconUri, requestHeaders, ^(UIImage *icon) { [weakSelf iconDidSettle:icon]; });
}

- (void)adoptFont:(UIFont *)font
{
  if (!font || [font isEqual:_font])
    return;
  _font = font;
  _labelWidth = 0;
}

- (NSString *)linkAccessibilityLabel
{
  NSString *original = _originalText.string;
  return [_label isEqualToString:original] ? original : [NSString stringWithFormat:@"%@, %@", _label, original];
}

- (CGFloat)boxHeight
{
  return ceil(_font.ascender - _font.descender + 2 * (_pill.paddingVertical + _pill.borderWidth));
}

- (CGFloat)widthForLimit:(CGFloat)available
{
  CGFloat iconWidth = _reservesIconSlot ? _font.pointSize * kIconSlotRatio : 0;
  if (_labelWidth <= 0)
    _labelWidth = ENRMLinkPillLabelWidth(_label, _font);
  CGFloat natural = ceil(_labelWidth + iconWidth + 2 * (_pill.paddingHorizontal + _pill.borderWidth));
  CGFloat limit = _pill.maxWidth > 0 ? MIN(available, _pill.maxWidth) : available;
  return MAX(1, MIN(natural, limit));
}

- (CGRect)attachmentBoundsForTextContainer:(NSTextContainer *)container
                      proposedLineFragment:(CGRect)lineFragment
                             glyphPosition:(CGPoint)position
                            characterIndex:(NSUInteger)characterIndex
{
  CGFloat available = CGFLOAT_MAX;
  if (container) {
    _textContainer = container;
    // Use the full container width, not the remainder of the current line. TextKit then moves
    // the whole attachment to the next line if it doesn't fit the remainder.
    NSTextStorage *storage = container.layoutManager.textStorage;
    NSParagraphStyle *paragraph = characterIndex < storage.length ? [storage attribute:NSParagraphStyleAttributeName
                                                                               atIndex:characterIndex
                                                                        effectiveRange:NULL]
                                                                  : nil;
    CGFloat indent = MAX(paragraph.firstLineHeadIndent, paragraph.headIndent);
    CGFloat tailInset = paragraph.tailIndent < 0 ? -paragraph.tailIndent : 0;
    available = MAX(1, container.size.width - 2 * container.lineFragmentPadding - indent - tailInset);
  } else if (lineFragment.size.width > 0 && lineFragment.size.width < 1e6) {
    // String drawing (table cells) lays out without a text container.
    available = lineFragment.size.width;
  }
  CGFloat inset = _pill.paddingVertical + _pill.borderWidth;
  return CGRectMake(0, _font.descender - inset, [self widthForLimit:available], self.boxHeight);
}

- (CGFloat)cornerRadius
{
  return MIN(_pill.borderRadius, self.boxHeight / 2);
}

- (UIImage *)imageForBounds:(CGRect)bounds textContainer:(NSTextContainer *)container characterIndex:(NSUInteger)index
{
  if (bounds.size.width <= 0 || bounds.size.height <= 0)
    return nil;
  if (_lifted)
    return ENRMClearLinkPillImage();
  if (container) {
    _textContainer = container;
    // The spoiler hides text by clearing its color, which this drawing does not use.
    NSTextStorage *storage = container.layoutManager.textStorage;
    if (index < storage.length && [storage attribute:SpoilerAttributeName atIndex:index effectiveRange:NULL])
      return ENRMClearLinkPillImage();
  }
  CGSize size = bounds.size;
  UIUserInterfaceStyle interfaceStyle = UITraitCollection.currentTraitCollection.userInterfaceStyle;
  ENRMLinkPillAppearance *appearance = [ENRMLinkPillAppearance new];
  appearance.variant = _variant;
  appearance.label = _label;
  appearance.font = _font;
  appearance.icon = _icon;
  appearance.iconTint = _iconTint;
  appearance.reservesIconSlot = _reservesIconSlot;
  appearance.size = size;
  appearance.interfaceStyle = interfaceStyle;
  UIImage *rendered = [ENRMRenderedLinkPills() objectForKey:appearance];
  if (rendered)
    return rendered;

  UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat preferredFormat];
  format.opaque = NO;
  UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:size format:format];
  UIImage *image = [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
    CGRect rect = (CGRect){CGPointZero, size};
    UIBezierPath *background = [UIBezierPath bezierPathWithRoundedRect:rect cornerRadius:_pill.borderRadius];
    [_variant.backgroundColor ?: UIColor.clearColor setFill];
    [background fill];
    if (_pill.borderWidth > 0) {
      UIBezierPath *border =
          [UIBezierPath bezierPathWithRoundedRect:CGRectInset(rect, _pill.borderWidth / 2, _pill.borderWidth / 2)
                                     cornerRadius:_pill.borderRadius];
      border.lineWidth = _pill.borderWidth;
      [_pill.borderColor setStroke];
      [border stroke];
    }
    [background addClip];
    CGFloat left = _pill.paddingHorizontal + _pill.borderWidth;
    CGFloat right = size.width - left;
    if (_reservesIconSlot && right - left >= _font.pointSize) {
      CGFloat side = _font.pointSize;
      if (_icon) {
        CGFloat scale = side / MAX(_icon.size.width, _icon.size.height);
        CGSize iconSize = CGSizeMake(_icon.size.width * scale, _icon.size.height * scale);
        CGRect iconRect = CGRectMake(left + (side - iconSize.width) / 2, (size.height - iconSize.height) / 2,
                                     iconSize.width, iconSize.height);
        UIImage *presented =
            _iconTint ? [_icon imageWithTintColor:_iconTint renderingMode:UIImageRenderingModeAlwaysOriginal] : _icon;
        [presented drawInRect:iconRect];
      }
      left += side * kIconSlotRatio;
    }
    NSMutableParagraphStyle *paragraph = [[NSMutableParagraphStyle alloc] init];
    paragraph.lineBreakMode = NSLineBreakByTruncatingTail;
    NSDictionary *attributes = @{
      NSFontAttributeName : _font,
      NSForegroundColorAttributeName : _variant.color ?: UIColor.labelColor,
      NSUnderlineStyleAttributeName : @(_variant.underline ? NSUnderlineStyleSingle : NSUnderlineStyleNone),
      NSParagraphStyleAttributeName : paragraph,
    };
    [_label drawInRect:CGRectMake(left, _pill.paddingVertical + _pill.borderWidth, MAX(0, right - left), size.height)
        withAttributes:attributes];
  }];
  [ENRMRenderedLinkPills() setObject:image forKey:appearance cost:ENRMImageByteCost(image)];
  return image;
}

#pragma mark - Asynchronous icon

- (void)iconDidSettle:(UIImage *)icon
{
  _icon = icon;
  BOOL slotReleased = icon == nil;
  if (slotReleased)
    _reservesIconSlot = NO;

  if (self.onIconLoaded)
    self.onIconLoaded();

  NSTextContainer *container = _textContainer;
  UITextView *textView = container ? objc_getAssociatedObject(container, kTextViewKey) : nil;
  if (!textView)
    return;
  NSRange range = [self rangeInText:textView.textStorage];
  if (range.location == NSNotFound)
    return;
  if (!slotReleased) {
    [textView.layoutManager invalidateDisplayForCharacterRange:range];
    return;
  }
  // The pill got narrower, so lines can reflow: lay out again and let the host re-measure.
  [textView.layoutManager invalidateLayoutForCharacterRange:range actualCharacterRange:NULL];
  id<ENRMImageLayoutObserver> observer = [textView enrm_imageLayoutObserver];
  if (observer)
    dispatch_async(dispatch_get_main_queue(), ^{ [observer imageAttachmentDidResolveLayout]; });
}

- (NSRange)rangeInText:(NSAttributedString *)text
{
  __block NSRange found = NSMakeRange(NSNotFound, 0);
  [text enumerateAttribute:NSAttachmentAttributeName
                   inRange:NSMakeRange(0, text.length)
                   options:NSAttributedStringEnumerationLongestEffectiveRangeNotRequired
                usingBlock:^(id value, NSRange range, BOOL *stop) {
                  if (value == self) {
                    found = range;
                    *stop = YES;
                  }
                }];
  return found;
}
@end

#endif
