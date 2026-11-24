#pragma once

#import "ENRMUIKit.h"

NS_ASSUME_NONNULL_BEGIN

/// Draws decorations (markers, borders, backgrounds) for the input layout manager.
@protocol ENRMInputDecorationDrawer <NSObject>

- (void)drawDecorationsForGlyphRange:(NSRange)glyphRange
                       layoutManager:(NSLayoutManager *)layoutManager
                             atPoint:(CGPoint)origin;

- (void)drawEmptyEditorDecorationsWithInset:(UIEdgeInsets)inset layoutManager:(NSLayoutManager *)layoutManager;

@end

NS_ASSUME_NONNULL_END
