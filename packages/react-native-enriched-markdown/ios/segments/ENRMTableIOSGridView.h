#pragma once

#include <TargetConditionals.h>
#if !TARGET_OS_OSX

#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^ENRMTableIOSLinkBlock)(NSString *url);

typedef NS_ENUM(NSInteger, ENRMTableIOSItemKind) {
  ENRMTableIOSItemKindLink,
  ENRMTableIOSItemKindImage,
};

/// An interactive item found under a point of the grid.
@interface ENRMTableIOSItemHit : NSObject
@property (nonatomic, assign) ENRMTableIOSItemKind kind;
@property (nonatomic, copy) NSString *url;
@property (nonatomic, copy) NSString *sourceType;
/// The link's visible label, or an image's alt text.
@property (nonatomic, copy, nullable) NSString *title;
/// The item's frame in grid coordinates.
@property (nonatomic, assign) CGRect frame;
@end

@interface ENRMTableIOSRowData : NSObject
@property (nonatomic, strong) NSArray<NSAttributedString *> *cellTexts;
@property (nonatomic, strong) UIColor *backgroundColor;
@end

/// Draws the entire table grid in a single drawRect: pass, avoiding
/// per-cell UITextView allocation and the TextKit layout storms that
/// cause multi-second main-thread hangs on large tables.
@interface ENRMTableIOSGridView : UIView

@property (nonatomic, copy, nullable) void (^onLinkTap)(NSString *url, NSString *sourceType);
@property (nonatomic, copy, nullable) ENRMTableIOSLinkBlock onLinkLongTap;
@property (nonatomic, copy, nullable) void (^onImageTap)(NSString *url, NSString *altText);
/// Asked when a touch lands on a link: a link with a menu is left to the context-menu
/// interaction, so the long-press recognizer must not take that touch.
@property (nonatomic, copy, nullable) BOOL (^hasLinkContextMenu)(NSString *url);
- (nullable ENRMTableIOSItemHit *)linkAtPoint:(CGPoint)point;

- (void)updateWithRows:(NSArray<ENRMTableIOSRowData *> *)rows
             columnWidths:(NSArray<NSNumber *> *)columnWidths
               rowHeights:(NSArray<NSNumber *> *)rowHeights
              borderColor:(UIColor *)borderColor
              borderWidth:(CGFloat)borderWidth
    horizontalCellPadding:(CGFloat)horizontalCellPadding
      verticalCellPadding:(CGFloat)verticalCellPadding
             cornerRadius:(CGFloat)cornerRadius;

- (void)fadeInRowsFrom:(NSUInteger)startRow duration:(NSTimeInterval)duration;

@end

NS_ASSUME_NONNULL_END

#endif // !TARGET_OS_OSX
