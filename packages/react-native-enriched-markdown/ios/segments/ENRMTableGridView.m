#import "ENRMTableGridView.h"
#import "ENRMMenuAction.h"

#if TARGET_OS_OSX

@implementation ENRMMacOSTableRowData
@end

@implementation ENRMTableGridView {
  NSArray<ENRMMacOSTableRowData *> *_tableRows;
  NSArray<NSNumber *> *_columnWidths;
  NSArray<NSNumber *> *_rowHeights;
  NSColor *_borderColor;
  CGFloat _borderWidth;
  CGFloat _horizontalCellPadding;
  CGFloat _verticalCellPadding;
  CGFloat _cornerRadius;
}

- (BOOL)isFlipped
{
  return YES;
}

- (void)updateWithRows:(NSArray<ENRMMacOSTableRowData *> *)rows
             columnWidths:(NSArray<NSNumber *> *)columnWidths
               rowHeights:(NSArray<NSNumber *> *)rowHeights
              borderColor:(NSColor *)borderColor
              borderWidth:(CGFloat)borderWidth
    horizontalCellPadding:(CGFloat)horizontalCellPadding
      verticalCellPadding:(CGFloat)verticalCellPadding
             cornerRadius:(CGFloat)cornerRadius
{
  _tableRows = rows;
  _columnWidths = columnWidths;
  _rowHeights = rowHeights;
  _borderColor = borderColor;
  _borderWidth = borderWidth;
  _horizontalCellPadding = horizontalCellPadding;
  _verticalCellPadding = verticalCellPadding;
  _cornerRadius = cornerRadius;
  [self setNeedsDisplay:YES];
}

- (NSMenu *)menuForEvent:(NSEvent *)event
{
  return _menuProvider ? _menuProvider() : [super menuForEvent:event];
}

- (void)drawRect:(NSRect)dirtyRect
{
  if (!_tableRows.count || !_columnWidths.count || !_rowHeights.count)
    return;

  [[NSGraphicsContext currentContext] saveGraphicsState];

  if (_cornerRadius > 0) {
    [[NSBezierPath bezierPathWithRoundedRect:self.bounds xRadius:_cornerRadius yRadius:_cornerRadius] setClip];
  }

  CGFloat yOffset = 0;
  for (NSUInteger r = 0; r < _tableRows.count; r++) {
    ENRMMacOSTableRowData *rowData = _tableRows[r];
    CGFloat rowHeight = [_rowHeights[r] doubleValue];
    CGFloat xOffset = 0;

    for (NSUInteger c = 0; c < rowData.cellTexts.count; c++) {
      CGFloat columnWidth = [_columnWidths[c] doubleValue];
      NSRect cellRect = NSMakeRect(xOffset, yOffset, columnWidth + _borderWidth, rowHeight + _borderWidth);

      [rowData.backgroundColor setFill];
      NSRectFill(cellRect);

      [_borderColor setStroke];
      NSBezierPath *border = [NSBezierPath bezierPathWithRect:cellRect];
      border.lineWidth = _borderWidth;
      [border stroke];

      NSAttributedString *text = rowData.cellTexts[c];
      if (text.length > 0) {
        NSRect textRect = NSMakeRect(xOffset + _horizontalCellPadding, yOffset + _verticalCellPadding,
                                     columnWidth - _horizontalCellPadding * 2, rowHeight - _verticalCellPadding * 2);
        [text drawWithRect:textRect
                   options:NSStringDrawingUsesLineFragmentOrigin | NSStringDrawingUsesFontLeading
                   context:nil];
      }

      xOffset += columnWidth;
    }
    yOffset += rowHeight;
  }

  [[NSGraphicsContext currentContext] restoreGraphicsState];
}

@end

#endif // TARGET_OS_OSX
