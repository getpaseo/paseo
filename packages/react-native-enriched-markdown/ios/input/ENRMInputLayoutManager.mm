#import "ENRMInputLayoutManager.h"
#import "ENRMInputListMarkerDrawer.h"

@implementation ENRMInputLayoutManager

- (instancetype)init
{
  if (self = [super init]) {
    _listMarkerDrawer = [[ENRMInputListMarkerDrawer alloc] init];
    _decorationDrawers = @[ _listMarkerDrawer ];
  }
  return self;
}

#pragma mark - NSLayoutManager Overrides

- (void)drawGlyphsForGlyphRange:(NSRange)glyphsToShow atPoint:(CGPoint)origin
{
  [super drawGlyphsForGlyphRange:glyphsToShow atPoint:origin];

  for (id<ENRMInputDecorationDrawer> drawer in _decorationDrawers) {
    [drawer drawDecorationsForGlyphRange:glyphsToShow layoutManager:self atPoint:origin];
  }
}

#pragma mark - Empty Editor

- (void)drawEmptyEditorDecorationsWithInset:(UIEdgeInsets)inset
{
  for (id<ENRMInputDecorationDrawer> drawer in _decorationDrawers) {
    [drawer drawEmptyEditorDecorationsWithInset:inset layoutManager:self];
  }
}

@end
