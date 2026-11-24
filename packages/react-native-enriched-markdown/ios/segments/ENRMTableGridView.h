#pragma once

#include <TargetConditionals.h>
#if TARGET_OS_OSX

#import "ENRMUIKit.h"

NS_ASSUME_NONNULL_BEGIN

@interface ENRMMacOSTableRowData : NSObject
@property (nonatomic, strong) NSArray<NSAttributedString *> *cellTexts;
@property (nonatomic, strong) NSColor *backgroundColor;
@end

/// Flipped NSView that draws the entire table (backgrounds, borders, text) in a
/// single drawRect: pass. Avoids all NSView subview hierarchy and CALayer
/// compositing issues on macOS where child views of layer-backed RCTUIViews
/// frequently fail to composite correctly.
@interface ENRMTableGridView : NSView

@property (nonatomic, copy, nullable) NSMenu *_Nullable (^menuProvider)(void);

- (void)updateWithRows:(NSArray<ENRMMacOSTableRowData *> *)rows
             columnWidths:(NSArray<NSNumber *> *)columnWidths
               rowHeights:(NSArray<NSNumber *> *)rowHeights
              borderColor:(NSColor *)borderColor
              borderWidth:(CGFloat)borderWidth
    horizontalCellPadding:(CGFloat)horizontalCellPadding
      verticalCellPadding:(CGFloat)verticalCellPadding
             cornerRadius:(CGFloat)cornerRadius;

@end

NS_ASSUME_NONNULL_END

#endif // TARGET_OS_OSX
