#import "TableContainerView.h"
#import "AttributedRenderer.h"
#import "ENRMAccessibilityLabels.h"
#import "ENRMHorizontalScrollView.h"
#import "ENRMImageAttachment.h"
#import "ENRMLinkPillAttachment.h"
#import "HTMLGenerator.h"
#import "LinkTapUtils.h"
#import "MarkdownASTNode.h"
#import "MarkdownASTSerializer.h"
#import "ParagraphStyleUtils.h"
#import "PasteboardUtils.h"
#import "RenderContext.h"
#import "StyleConfig.h"
#include <TargetConditionals.h>
#if TARGET_OS_OSX
#import "ENRMMenuAction.h"
#import "ENRMTableGridView.h"
#else
#import "ENRMTableIOSGridView.h"
#endif

@interface TableCellData : NSObject
@property (nonatomic, strong) NSMutableAttributedString *attributedText;
@property (nonatomic, copy) NSString *plainText;
@property (nonatomic, copy) NSString *markdownText;
@property (nonatomic, assign) BOOL isHeader;
@property (nonatomic, assign) NSTextAlignment alignment;
@end

@implementation TableCellData
@end

// Cell rendering and layout are view-free statics so the instance path
// (applyTableNode:/computeLayout) and the shadow-measurement class method
// (+measureHeightForTableNode:...) share one implementation and cannot drift
// (issue #550).

static NSTextAlignment ENRMTableTextAlignmentFromString(NSString *align)
{
  if ([align isEqualToString:@"center"])
    return NSTextAlignmentCenter;
  if ([align isEqualToString:@"right"])
    return NSTextAlignmentRight;
  return NSTextAlignmentLeft;
}

static NSString *ENRMTablePlainTextFromNode(MarkdownASTNode *node)
{
  if (!node)
    return @"";
  NSMutableString *buffer = [node.content mutableCopy] ?: [NSMutableString string];
  for (MarkdownASTNode *child in node.children) {
    [buffer appendString:ENRMTablePlainTextFromNode(child)];
  }
  return [buffer copy];
}

static StyleConfig *ENRMTableCellConfig(StyleConfig *config, BOOL isHeader)
{
  StyleConfig *cellConfig = [config copy];

  [cellConfig setParagraphFontSize:config.tableFontSize];
  NSString *headerFamily =
      config.tableHeaderFontFamily.length > 0 ? config.tableHeaderFontFamily : config.tableFontFamily;
  [cellConfig setParagraphFontFamily:isHeader ? headerFamily : config.tableFontFamily];
  [cellConfig setParagraphFontWeight:isHeader ? @"bold" : config.tableFontWeight];
  [cellConfig setParagraphColor:isHeader ? config.tableHeaderTextColor : config.tableColor];
  [cellConfig setParagraphLineHeight:config.tableLineHeight];

  [cellConfig setParagraphMarginTop:0];
  [cellConfig setParagraphMarginBottom:0];

  return cellConfig;
}

static NSMutableAttributedString *ENRMTableRenderCellNode(MarkdownASTNode *cellNode, StyleConfig *cellConfig,
                                                          NSTextAlignment alignment, BOOL allowFontScaling,
                                                          CGFloat maxFontSizeMultiplier,
                                                          ENRMWritingDirectionMode writingDirectionMode,
                                                          NSWritingDirection resolvedLayoutDirection)
{
  AttributedRenderer *renderer = [[AttributedRenderer alloc] initWithConfig:cellConfig];
  RenderContext *context = [RenderContext new];
  context.allowFontScaling = allowFontScaling;
  context.maxFontSizeMultiplier = maxFontSizeMultiplier;

  NSMutableAttributedString *attributedText = [renderer renderNodes:cellNode.children context:context block:nil];

  [context applyLinkAttributesToString:attributedText];
  [context applyImageAttributesToString:attributedText];

  ENRMPinLineMetricsToStyledFonts(attributedText, NSMakeRange(0, attributedText.length));
  ENRMApplyWritingDirectionMode(attributedText, writingDirectionMode, resolvedLayoutDirection);

  if (alignment != NSTextAlignmentLeft && attributedText.length > 0) {
    NSRange fullRange = NSMakeRange(0, attributedText.length);
    [attributedText
        enumerateAttribute:NSParagraphStyleAttributeName
                   inRange:fullRange
                   options:0
                usingBlock:^(NSParagraphStyle *paragraphStyle, NSRange range, BOOL *stop) {
                  NSMutableParagraphStyle *mutableStyle =
                      paragraphStyle ? [paragraphStyle mutableCopy] : [[NSMutableParagraphStyle alloc] init];
                  mutableStyle.alignment = alignment;
                  [attributedText addAttribute:NSParagraphStyleAttributeName value:mutableStyle range:range];
                }];
  }

  return attributedText;
}

// The grid rasterizes each cell's attributed string via -drawWithRect: in a single
// drawRect: pass, so an image attachment loading asynchronously has no live text view
// to invalidate (its -refreshDisplay no-ops). Point every cell image at the grid's own
// redraw so the cell repaints once the image finishes loading.
static void ENRMTableWireImageRedraw(NSArray<NSArray<TableCellData *> *> *rows, void (^redraw)(void))
{
  for (NSArray<TableCellData *> *row in rows) {
    for (TableCellData *cell in row) {
      NSAttributedString *text = cell.attributedText;
      if (text.length == 0)
        continue;
      [text enumerateAttribute:NSAttachmentAttributeName
                       inRange:NSMakeRange(0, text.length)
                       options:0
                    usingBlock:^(id value, NSRange range, BOOL *stop) {
                      if ([value isKindOfClass:[ENRMImageAttachment class]]) {
                        ((ENRMImageAttachment *)value).onImageLoaded = redraw;
                      }
#if !TARGET_OS_OSX
                      if ([value isKindOfClass:[ENRMLinkPillAttachment class]]) {
                        ((ENRMLinkPillAttachment *)value).onIconLoaded = redraw;
                      }
#endif
                    }];
    }
  }
}

static NSArray<NSArray<TableCellData *> *> *ENRMTableBuildRows(MarkdownASTNode *tableNode, StyleConfig *config,
                                                               BOOL allowFontScaling, CGFloat maxFontSizeMultiplier,
                                                               ENRMWritingDirectionMode writingDirectionMode,
                                                               NSWritingDirection resolvedLayoutDirection,
                                                               NSUInteger *outColCount)
{
  StyleConfig *headerCellConfig = ENRMTableCellConfig(config, YES);
  StyleConfig *bodyCellConfig = ENRMTableCellConfig(config, NO);

  NSMutableArray *allRows = [NSMutableArray array];
  NSUInteger colCount = 0;

  for (MarkdownASTNode *section in tableNode.children) {
    BOOL isSectionHead = (section.type == MarkdownNodeTypeTableHead);

    for (MarkdownASTNode *rowNode in section.children) {
      if (rowNode.type != MarkdownNodeTypeTableRow)
        continue;

      NSMutableArray<TableCellData *> *rowCells = [NSMutableArray array];
      for (MarkdownASTNode *cellNode in rowNode.children) {
        TableCellData *cell = [[TableCellData alloc] init];
        cell.isHeader = isSectionHead || (cellNode.type == MarkdownNodeTypeTableHeaderCell);
        cell.alignment = ENRMTableTextAlignmentFromString(cellNode.attributes[@"align"]);
        cell.plainText = ENRMTablePlainTextFromNode(cellNode);
        cell.markdownText = markdownFromASTNodeChildren(cellNode);

        StyleConfig *cellConfig = cell.isHeader ? headerCellConfig : bodyCellConfig;
        cell.attributedText =
            ENRMTableRenderCellNode(cellNode, cellConfig, cell.alignment, allowFontScaling, maxFontSizeMultiplier,
                                    writingDirectionMode, resolvedLayoutDirection);
        [rowCells addObject:cell];
      }
      colCount = MAX(colCount, rowCells.count);
      [allRows addObject:rowCells];
    }
  }

  if (outColCount != NULL) {
    *outColCount = colCount;
  }
  return [allRows copy];
}

static void ENRMTableComputeLayout(NSArray<NSArray<TableCellData *> *> *rows, NSUInteger colCount, StyleConfig *config,
                                   CGFloat borderWidth, NSMutableArray<NSNumber *> *_Nullable *_Nullable outColWidths,
                                   NSMutableArray<NSNumber *> *_Nullable *_Nullable outRowHeights,
                                   CGFloat *_Nullable outTotalWidth, CGFloat *_Nullable outTotalHeight)
{
  // TODO: Consider making minColumnWidth / maxColumnWidth configurable via style props
  const CGFloat minimumColumnWidth = 60.0;
  const CGFloat maximumColumnWidth = 300.0;
  const CGFloat horizontalPadding = config.tableCellPaddingHorizontal * 2;
  const CGFloat verticalPadding = config.tableCellPaddingVertical * 2;

  NSMutableArray<NSNumber *> *colWidths = [NSMutableArray arrayWithCapacity:colCount];
  for (NSUInteger i = 0; i < colCount; i++)
    [colWidths addObject:@0];

  for (NSArray<TableCellData *> *row in rows) {
    for (NSUInteger column = 0; column < row.count; column++) {
      CGRect boundingRect = [row[column].attributedText
          boundingRectWithSize:CGSizeMake(maximumColumnWidth, CGFLOAT_MAX)
                       options:NSStringDrawingUsesLineFragmentOrigin | NSStringDrawingUsesFontLeading
                       context:nil];
      CGFloat width = MIN(MAX(ceil(boundingRect.size.width) + horizontalPadding, minimumColumnWidth),
                          maximumColumnWidth + horizontalPadding);
      if (width > [colWidths[column] doubleValue])
        colWidths[column] = @(width);
    }
  }

  NSMutableArray<NSNumber *> *rowHeights = [NSMutableArray arrayWithCapacity:rows.count];
  for (NSArray<TableCellData *> *row in rows) {
    CGFloat maxHeight = 0;
    for (NSUInteger column = 0; column < row.count; column++) {
      CGFloat availableWidth = [colWidths[column] doubleValue] - horizontalPadding;
      CGRect boundingRect = [row[column].attributedText
          boundingRectWithSize:CGSizeMake(availableWidth, CGFLOAT_MAX)
                       options:NSStringDrawingUsesLineFragmentOrigin | NSStringDrawingUsesFontLeading
                       context:nil];
      maxHeight = MAX(maxHeight, ceil(boundingRect.size.height) + verticalPadding);
    }
    [rowHeights addObject:@(maxHeight)];
  }

  if (outColWidths != NULL)
    *outColWidths = colWidths;
  if (outRowHeights != NULL)
    *outRowHeights = rowHeights;
  if (outTotalWidth != NULL)
    *outTotalWidth = [[colWidths valueForKeyPath:@"@sum.self"] doubleValue] + borderWidth;
  if (outTotalHeight != NULL)
    *outTotalHeight = [[rowHeights valueForKeyPath:@"@sum.self"] doubleValue] + borderWidth;
}

#if !TARGET_OS_OSX
@interface TableContainerView () <UIContextMenuInteractionDelegate>
@end
#else
@interface TableContainerView ()
@end
#endif

@implementation TableContainerView {
  ENRMHorizontalScrollView *_scrollView;
  RCTUIView *_gridContainer;
  NSArray<NSArray<TableCellData *> *> *_rows;
  NSUInteger _colCount;

  NSMutableArray<NSNumber *> *_colWidths;
  NSMutableArray<NSNumber *> *_rowHeights;
  CGFloat _totalTableWidth;
  CGFloat _totalTableHeight;

  NSString *_cachedMarkdown;

  NSArray *_cachedAccessibilityElements;

  BOOL _imageRemeasurePending;
  // Frame, in grid coordinates, of the link whose menu is being presented. Null for the table's own menu.
  CGRect _linkMenuFrame;
#if !TARGET_OS_OSX
  ENRMLinkMenuLift *_linkMenuLift;
#endif
}

- (instancetype)initWithConfig:(StyleConfig *)config
{
  self = [super initWithFrame:CGRectZero];
  if (self) {
    _config = config;
    _allowFontScaling = YES;
    _maxFontSizeMultiplier = 0;
    _enableLinkPreview = YES;
    _dynamicProps = [[ENRMDynamicBlockProps alloc] init];
    _writingDirectionMode = ENRMWritingDirectionModeFirstStrong;
    _resolvedLayoutDirection = NSWritingDirectionLeftToRight;
    [self setupScrollView];
  }
  return self;
}

- (void)setupScrollView
{
  _scrollView = [[ENRMHorizontalScrollView alloc] init];
  _scrollView.showsVerticalScrollIndicator = NO;
  _scrollView.showsHorizontalScrollIndicator = YES;
#if !TARGET_OS_OSX
  _scrollView.alwaysBounceHorizontal = NO;
  _scrollView.isAccessibilityElement = NO;
  _scrollView.accessibilityElementsHidden = YES;
#endif
  [self addSubview:_scrollView];

#if TARGET_OS_OSX
  // On macOS, use ENRMTableGridView as the NSScrollView documentView so that the
  // coordinate system is managed correctly and the entire table is drawn in
  // a single drawRect: pass (no subview / layer compositing issues).
  ENRMTableGridView *gridView = [[ENRMTableGridView alloc] initWithFrame:CGRectZero];
  __weak TableContainerView *weakSelf = self;
  gridView.menuProvider = ^NSMenu *
  {
    TableContainerView *strongSelf = weakSelf;
    if (!strongSelf || !strongSelf.dynamicProps.enableBlockContextMenu)
      return nil;
    NSMenu *menu = [[NSMenu alloc] initWithTitle:@""];
    [menu addItem:ENRMCreateMenuItem(strongSelf.dynamicProps.menuCopyLabel, ^{ [strongSelf copyTableToPasteboard]; })];
    [menu addItem:ENRMCreateMenuItem(strongSelf.dynamicProps.menuCopyAsMarkdownLabel,
                                     ^{ [strongSelf copyMarkdownToPasteboard]; })];
    return menu;
  };
  _gridContainer = gridView;
  [(NSScrollView *)_scrollView setDocumentView:_gridContainer];
#else
  ENRMTableIOSGridView *iosGridView = [[ENRMTableIOSGridView alloc] initWithFrame:CGRectZero];
  __weak TableContainerView *weakSelf = self;
  iosGridView.onLinkTap = ^(NSString *url, NSString *sourceType) {
    TableContainerView *strongSelf = weakSelf;
    if (strongSelf && strongSelf.onLinkPress)
      strongSelf.onLinkPress(url, sourceType);
  };
  iosGridView.onImageTap = ^(NSString *url, NSString *altText) {
    TableContainerView *strongSelf = weakSelf;
    if (strongSelf.onImagePress)
      strongSelf.onImagePress(url, altText);
  };
  iosGridView.hasLinkContextMenu =
      ^BOOL(NSString *url) { return [weakSelf.dynamicProps.linkContextMenus hasMenuForURL:url]; };
  iosGridView.onLinkLongTap = ^(NSString *url) {
    TableContainerView *strongSelf = weakSelf;
    if (strongSelf && strongSelf.onLinkLongPress)
      strongSelf.onLinkLongPress(url);
  };
  _gridContainer = iosGridView;
  [_scrollView addSubview:_gridContainer];
  UIContextMenuInteraction *contextMenu = [[UIContextMenuInteraction alloc] initWithDelegate:self];
  [_gridContainer addInteraction:contextMenu];
#endif
}

- (NSUInteger)rowCount
{
  return _rows.count;
}

#if !TARGET_OS_OSX
- (void)animateNewRowsFromPreviousCount:(NSUInteger)previousRowCount duration:(NSTimeInterval)duration
{
  if (self.rowCount <= previousRowCount) {
    return;
  }
  [(ENRMTableIOSGridView *)_gridContainer fadeInRowsFrom:previousRowCount duration:duration];
}
#else
- (void)animateNewRowsFromPreviousCount:(NSUInteger)previousRowCount duration:(NSTimeInterval)duration
{
  // No-op on macOS
}
#endif

- (void)applyTableNode:(MarkdownASTNode *)tableNode
{
  [[_gridContainer subviews] makeObjectsPerformSelector:@selector(removeFromSuperview)];

  NSUInteger colCount = 0;
  _rows = ENRMTableBuildRows(tableNode, self.config, self.allowFontScaling, self.maxFontSizeMultiplier,
                             _writingDirectionMode, _resolvedLayoutDirection, &colCount);
  _colCount = colCount;
  _cachedMarkdown = [self buildMarkdownFromRows];
  _cachedAccessibilityElements = nil;
  [self computeLayout];
  [self renderGrid];
}

- (void)computeLayout
{
  NSMutableArray<NSNumber *> *colWidths = nil;
  NSMutableArray<NSNumber *> *rowHeights = nil;
  CGFloat totalWidth = 0;
  CGFloat totalHeight = 0;
  ENRMTableComputeLayout(_rows, _colCount, self.config, self.config.tableBorderWidth, &colWidths, &rowHeights,
                         &totalWidth, &totalHeight);
  _colWidths = colWidths;
  _rowHeights = rowHeights;
  _totalTableWidth = totalWidth;
  _totalTableHeight = totalHeight;
}

+ (CGFloat)measureHeightForTableNode:(MarkdownASTNode *)tableNode
                              config:(StyleConfig *)config
                    allowFontScaling:(BOOL)allowFontScaling
               maxFontSizeMultiplier:(CGFloat)maxFontSizeMultiplier
                writingDirectionMode:(ENRMWritingDirectionMode)writingDirectionMode
             resolvedLayoutDirection:(NSWritingDirection)resolvedLayoutDirection
{
  NSUInteger colCount = 0;
  NSArray<NSArray<TableCellData *> *> *rows =
      ENRMTableBuildRows(tableNode, config, allowFontScaling, maxFontSizeMultiplier, writingDirectionMode,
                         resolvedLayoutDirection, &colCount);
  if (rows.count == 0)
    return 0;

  CGFloat totalHeight = 0;
  ENRMTableComputeLayout(rows, colCount, config, config.tableBorderWidth, NULL, NULL, NULL, &totalHeight);
  return totalHeight;
}

- (void)renderGrid
{
#if !TARGET_OS_OSX
  [self renderGridIOS];
#else
  [self renderGridMacOS];
#endif
}

- (RCTUIColor *)backgroundColorForRowIsHeader:(BOOL)isHeader bodyRowIndex:(NSUInteger)bodyRowIndex
{
  if (isHeader) {
    return self.config.tableHeaderBackgroundColor;
  }
  return (bodyRowIndex % 2 == 0) ? self.config.tableRowEvenBackgroundColor : self.config.tableRowOddBackgroundColor;
}

- (NSArray<NSAttributedString *> *)attributedTextsForRow:(NSArray<TableCellData *> *)rowCells
{
  NSMutableArray<NSAttributedString *> *cellTexts = [NSMutableArray arrayWithCapacity:_colCount];
  for (NSUInteger columnIndex = 0; columnIndex < _colCount; columnIndex++) {
    NSAttributedString *text = (columnIndex < rowCells.count) ? rowCells[columnIndex].attributedText : nil;
    [cellTexts addObject:text ?: [[NSAttributedString alloc] init]];
  }
  return [cellTexts copy];
}

#if TARGET_OS_OSX
- (void)renderGridMacOS
{
  _gridContainer.frame = CGRectMake(0, 0, _totalTableWidth, _totalTableHeight);

  NSUInteger bodyRowIndex = 0;
  NSMutableArray<ENRMMacOSTableRowData *> *rowDataArray = [NSMutableArray arrayWithCapacity:_rows.count];

  for (NSArray<TableCellData *> *rowCells in _rows) {
    BOOL isHeaderRow = (rowCells.count > 0 && rowCells.firstObject.isHeader);

    ENRMMacOSTableRowData *rowData = [[ENRMMacOSTableRowData alloc] init];
    rowData.backgroundColor = [self backgroundColorForRowIsHeader:isHeaderRow bodyRowIndex:bodyRowIndex];
    rowData.cellTexts = [self attributedTextsForRow:rowCells];
    [rowDataArray addObject:rowData];

    if (!isHeaderRow) {
      bodyRowIndex++;
    }
  }

  ENRMTableGridView *gridView = (ENRMTableGridView *)_gridContainer;
  [gridView updateWithRows:[rowDataArray copy]
               columnWidths:_colWidths
                 rowHeights:_rowHeights
                borderColor:self.config.tableBorderColor
                borderWidth:self.config.tableBorderWidth
      horizontalCellPadding:self.config.tableCellPaddingHorizontal
        verticalCellPadding:self.config.tableCellPaddingVertical
               cornerRadius:self.config.tableBorderRadius];

  __weak TableContainerView *weakSelf = self;
  ENRMTableWireImageRedraw(_rows, ^{ [weakSelf handleCellImageResolved]; });
}

#else

- (void)renderGridIOS
{
  _gridContainer.frame = CGRectMake(0, 0, _totalTableWidth, _totalTableHeight);
  _gridContainer.layer.cornerRadius = self.config.tableBorderRadius;
  _gridContainer.layer.masksToBounds = YES;

  NSUInteger bodyRowIndex = 0;
  NSMutableArray<ENRMTableIOSRowData *> *rowDataArray = [NSMutableArray arrayWithCapacity:_rows.count];

  for (NSArray<TableCellData *> *rowCells in _rows) {
    BOOL isHeaderRow = (rowCells.count > 0 && rowCells.firstObject.isHeader);

    ENRMTableIOSRowData *rowData = [[ENRMTableIOSRowData alloc] init];
    rowData.backgroundColor = [self backgroundColorForRowIsHeader:isHeaderRow bodyRowIndex:bodyRowIndex];
    rowData.cellTexts = [self attributedTextsForRow:rowCells];
    [rowDataArray addObject:rowData];

    if (!isHeaderRow) {
      bodyRowIndex++;
    }
  }

  ENRMTableIOSGridView *gridView = (ENRMTableIOSGridView *)_gridContainer;
  [gridView updateWithRows:[rowDataArray copy]
               columnWidths:_colWidths
                 rowHeights:_rowHeights
                borderColor:self.config.tableBorderColor
                borderWidth:self.config.tableBorderWidth
      horizontalCellPadding:self.config.tableCellPaddingHorizontal
        verticalCellPadding:self.config.tableCellPaddingVertical
               cornerRadius:self.config.tableBorderRadius];

  __weak TableContainerView *weakSelf = self;
  ENRMTableWireImageRedraw(_rows, ^{ [weakSelf handleCellImageResolved]; });
}
#endif

// A dynamic cell image (maxHeight / aspectRatio) resolves its box height only after
// loading. Recompute this table's layout locally; if a row height actually changed
// (the maxHeight fitted case) or a column width did (a link pill whose icon failed gives
// up its slot), re-render and ask the host to re-measure its Fabric
// height, otherwise just repaint the freshly loaded pixels. The height guard makes this
// a no-op once heights are stable, so a deterministic image never churns, and the host's
// own needs-update guard stops the propagation from looping.
- (void)handleCellImageResolved
{
  if (_imageRemeasurePending) {
    return;
  }
  _imageRemeasurePending = YES;
  __weak TableContainerView *weakSelf = self;
  dispatch_async(dispatch_get_main_queue(), ^{
    TableContainerView *strongSelf = weakSelf;
    if (!strongSelf) {
      return;
    }
    strongSelf->_imageRemeasurePending = NO;
    [strongSelf remeasureForCellImage];
  });
}

- (void)remeasureForCellImage
{
  if (_rows.count == 0) {
    return;
  }
#if !TARGET_OS_OSX
  // The grid is about to change under the lifted link's image.
  [_linkMenuLift end];
#endif
  NSArray<NSNumber *> *oldColWidths = _colWidths;
  NSArray<NSNumber *> *oldRowHeights = _rowHeights;
  CGFloat oldTotalHeight = _totalTableHeight;
  [self computeLayout];

  BOOL changed = ![_colWidths isEqualToArray:oldColWidths] || ![_rowHeights isEqualToArray:oldRowHeights] ||
                 fabs(_totalTableHeight - oldTotalHeight) > 0.5;
  if (!changed) {
#if TARGET_OS_OSX
    _gridContainer.needsDisplay = YES;
#else
    [_gridContainer setNeedsDisplay];
#endif
    return;
  }

  [self renderGrid];
  [self setNeedsLayout];

  [[self.superview enrm_imageLayoutObserver] imageAttachmentDidResolveLayout];
}

#if !TARGET_OS_OSX
/// A link's menu lifts only the link, see `ENRMLinkMenuLift`; the table's own menu (no link
/// frame) lifts the whole grid.
- (UITargetedPreview *)linkPreviewForInteraction:(UIContextMenuInteraction *)interaction
{
  UIView *grid = interaction.view;
  if (CGRectIsNull(_linkMenuFrame))
    return nil;
  if (![_linkMenuLift isOverView:grid]) {
    // A little of the cell around the link, so that the lifted image has the cell's background.
    CGRect frame = CGRectIntersection(CGRectInset(_linkMenuFrame, -4, -2), grid.bounds);
    if (grid.window == nil || CGRectIsEmpty(frame))
      return nil;
    UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:frame.size];
    UIImage *image = [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
      CGContextTranslateCTM(context.CGContext, -frame.origin.x, -frame.origin.y);
      [grid.layer renderInContext:context.CGContext];
    }];
    if (!_linkMenuLift)
      _linkMenuLift = [[ENRMLinkMenuLift alloc] init];
    [_linkMenuLift layImage:image atFrame:frame overView:grid];
  }
  return [_linkMenuLift previewWithCornerRadius:8 backgroundColor:nil];
}

- (UITargetedPreview *)contextMenuInteraction:(UIContextMenuInteraction *)interaction
    previewForHighlightingMenuWithConfiguration:(UIContextMenuConfiguration *)configuration
{
  return [self linkPreviewForInteraction:interaction];
}

- (UITargetedPreview *)contextMenuInteraction:(UIContextMenuInteraction *)interaction
    previewForDismissingMenuWithConfiguration:(UIContextMenuConfiguration *)configuration
{
  return [self linkPreviewForInteraction:interaction];
}

- (void)contextMenuInteraction:(UIContextMenuInteraction *)interaction
       willEndForConfiguration:(UIContextMenuConfiguration *)configuration
                      animator:(id<UIContextMenuInteractionAnimating>)animator
{
  [_linkMenuLift endWithAnimator:animator];
}

- (UIContextMenuConfiguration *)contextMenuInteraction:(UIContextMenuInteraction *)interaction
                        configurationForMenuAtLocation:(CGPoint)location
{
  ENRMTableIOSItemHit *link = [(ENRMTableIOSGridView *)_gridContainer linkAtPoint:location];
  UIMenu *linkMenu = [self.dynamicProps.linkContextMenus menuForURL:link.url title:link.title];
  [_linkMenuLift end];
  // UIKit replaces a nil identifier with one of its own, so the frame tells the menus apart.
  _linkMenuFrame = linkMenu ? link.frame : CGRectNull;
  if (linkMenu) {
    return [UIContextMenuConfiguration
        configurationWithIdentifier:link.url
                    previewProvider:nil
                     actionProvider:^UIMenu *(NSArray<UIMenuElement *> *suggestedActions) { return linkMenu; }];
  }
  if (!self.dynamicProps.enableBlockContextMenu) {
    return nil;
  }
  return [UIContextMenuConfiguration
      configurationWithIdentifier:nil
                  previewProvider:nil
                   actionProvider:^UIMenu *(NSArray<UIMenuElement *> *suggestedActions) {
                     UIAction *copyMarkdown =
                         [UIAction actionWithTitle:self.dynamicProps.menuCopyAsMarkdownLabel
                                             image:[RCTUIImage systemImageNamed:@"doc.text"]
                                        identifier:nil
                                           handler:^(__kindof UIAction *action) { [self copyMarkdownToPasteboard]; }];

                     UIAction *copyPlainText =
                         [UIAction actionWithTitle:self.dynamicProps.menuCopyLabel
                                             image:[RCTUIImage systemImageNamed:@"doc.on.doc"]
                                        identifier:nil
                                           handler:^(__kindof UIAction *action) { [self copyTableToPasteboard]; }];

                     return [UIMenu menuWithTitle:@"" children:@[ copyPlainText, copyMarkdown ]];
                   }];
}
#endif // !TARGET_OS_OSX

- (void)copyMarkdownToPasteboard
{
  if (_cachedMarkdown.length > 0) {
    copyStringToPasteboard(_cachedMarkdown);
  }
}

- (void)copyTableToPasteboard
{
  NSString *plainText = [self buildPlainTextFromRows];
  if (plainText.length == 0)
    return;

  NSMutableDictionary *items = [NSMutableDictionary dictionary];
  items[kUTIPlainText] = plainText;

  if (_cachedMarkdown.length > 0) {
    items[kUTIMarkdown] = _cachedMarkdown;
  }

  NSString *html = generateTableHTML([self rowDictionariesForHTML], self.config);
  if (html.length > 0) {
    NSData *htmlData = [html dataUsingEncoding:NSUTF8StringEncoding];
    if (htmlData)
      items[kUTIHTML] = htmlData;
  }

  copyItemsToPasteboard(items);
}

- (NSString *)buildMarkdownFromRows
{
  if (_rows.count == 0 || _colCount == 0)
    return @"";

  NSMutableString *markdown = [NSMutableString string];
  BOOL headerSeparatorAdded = NO;

  for (NSArray<TableCellData *> *row in _rows) {
    NSMutableArray<NSString *> *cellStrings = [NSMutableArray arrayWithCapacity:_colCount];

    for (NSUInteger column = 0; column < _colCount; column++) {
      NSString *cellMarkdown = (column < row.count) ? (row[column].markdownText ?: @"") : @"";
      [cellStrings addObject:cellMarkdown];
    }

    [markdown appendFormat:@"| %@ |\n", [cellStrings componentsJoinedByString:@" | "]];

    if (!headerSeparatorAdded && row.count > 0 && row.firstObject.isHeader) {
      NSMutableArray<NSString *> *separators = [NSMutableArray arrayWithCapacity:_colCount];

      for (NSUInteger column = 0; column < _colCount; column++) {
        NSTextAlignment columnAlignment = (column < row.count) ? row[column].alignment : NSTextAlignmentLeft;

        switch (columnAlignment) {
          case NSTextAlignmentCenter:
            [separators addObject:@":---:"];
            break;
          case NSTextAlignmentRight:
            [separators addObject:@"---:"];
            break;
          default:
            [separators addObject:@"---"];
            break;
        }
      }

      [markdown appendFormat:@"| %@ |\n", [separators componentsJoinedByString:@" | "]];
      headerSeparatorAdded = YES;
    }
  }

  return [markdown copy];
}

- (NSString *)buildPlainTextFromRows
{
  if (_rows.count == 0)
    return @"";

  NSMutableString *result = [NSMutableString string];

  for (NSArray<TableCellData *> *row in _rows) {
    NSMutableArray<NSString *> *rowContent = [NSMutableArray arrayWithCapacity:row.count];

    for (TableCellData *cell in row) {
      [rowContent addObject:cell.plainText ?: @""];
    }

    [result appendFormat:@"%@\n", [rowContent componentsJoinedByString:@"\t"]];
  }

  return [result copy];
}

- (NSArray<NSArray<NSDictionary *> *> *)rowDictionariesForHTML
{
  NSMutableArray *rowsResult = [NSMutableArray arrayWithCapacity:_rows.count];

  for (NSArray<TableCellData *> *cellDataRow in _rows) {
    NSMutableArray *rowDictionaries = [NSMutableArray arrayWithCapacity:cellDataRow.count];

    for (TableCellData *cell in cellDataRow) {
      NSAttributedString *text = cell.attributedText ?: [[NSAttributedString alloc] init];

      NSDictionary *cellDict =
          @{@"attributedText" : text, @"isHeader" : @(cell.isHeader), @"alignment" : @(cell.alignment)};

      [rowDictionaries addObject:cellDict];
    }

    [rowsResult addObject:[rowDictionaries copy]];
  }

  return [rowsResult copy];
}

- (CGFloat)measureHeight:(CGFloat)maxWidth
{
  if (_rows.count == 0)
    return 0;
  if (_rowHeights.count == 0)
    [self computeLayout];
  return _totalTableHeight;
}

- (CGFloat)alignOffsetForFreeSpace:(CGFloat)freeSpace
{
  if (freeSpace <= 0)
    return 0;
  NSString *align = self.config.tableAlign;
  if ([align isEqualToString:@"center"])
    return freeSpace / 2;
  if ([align isEqualToString:@"right"])
    return freeSpace;
  return 0;
}

- (void)layoutSubviews
{
  [super layoutSubviews];
  _scrollView.frame = self.bounds;
#if !TARGET_OS_OSX
  CGFloat overhang = MAX(self.config.tableHorizontalOverflow, 0);
  CGFloat containerWidth = self.bounds.size.width;
  BOOL tableOverflows = (overhang > 0 && _totalTableWidth > containerWidth);

  if (tableOverflows) {
    UIEdgeInsets inset = UIEdgeInsetsMake(0, overhang, 0, overhang);
    if (!UIEdgeInsetsEqualToEdgeInsets(_scrollView.contentInset, inset)) {
      _scrollView.contentInset = inset;
      _scrollView.contentOffset = CGPointMake(-overhang, 0);
    }
    _scrollView.contentSize = CGSizeMake(_totalTableWidth, _totalTableHeight);
    _scrollView.scrollEnabled = YES;
    _gridContainer.frame = CGRectMake(0, 0, _totalTableWidth, _totalTableHeight);
  } else {
    CGFloat alignOffset = [self alignOffsetForFreeSpace:containerWidth - overhang * 2 - _totalTableWidth];
    _scrollView.contentInset = UIEdgeInsetsZero;
    _scrollView.contentOffset = CGPointZero;
    _scrollView.contentSize = CGSizeMake(MAX(_totalTableWidth, containerWidth), _totalTableHeight);
    _scrollView.scrollEnabled = (_totalTableWidth > containerWidth);
    _gridContainer.frame = CGRectMake(overhang + alignOffset, 0, _totalTableWidth, _totalTableHeight);
  }
#else
  CGFloat overhang = MAX(self.config.tableHorizontalOverflow, 0);
  CGFloat containerWidth = self.bounds.size.width;
  BOOL tableOverflows = (overhang > 0 && _totalTableWidth > containerWidth);

  if (tableOverflows) {
    _gridContainer.frame = CGRectMake(0, 0, _totalTableWidth, _totalTableHeight);
  } else if (_totalTableWidth > 0 && _totalTableHeight > 0) {
    CGFloat alignOffset = [self alignOffsetForFreeSpace:containerWidth - overhang * 2 - _totalTableWidth];
    _gridContainer.frame = CGRectMake(overhang + alignOffset, 0, _totalTableWidth, _totalTableHeight);
  }
#endif
}

- (BOOL)isAccessibilityElement
{
  return NO;
}

- (void)setAccessibilityLabels:(ENRMAccessibilityLabels *)labels
{
  if (_accessibilityLabels == labels)
    return;
  _accessibilityLabels = labels;
  _cachedAccessibilityElements = nil;
}

- (NSArray *)accessibilityElements
{
  if (_rows.count == 0)
    return nil;
  if (_cachedAccessibilityElements != nil)
    return _cachedAccessibilityElements;

  NSMutableArray *elements = [NSMutableArray array];
  CGFloat yOffset = 0;

  for (NSUInteger rowIndex = 0; rowIndex < _rows.count; rowIndex++) {
    NSArray<TableCellData *> *row = _rows[rowIndex];
    CGFloat rowHeight = [_rowHeights[rowIndex] doubleValue];

    NSMutableArray *cellTexts = [NSMutableArray array];
    for (TableCellData *cell in row) {
      if (cell.plainText.length > 0)
        [cellTexts addObject:cell.plainText];
    }

    if (cellTexts.count > 0) {
#if !TARGET_OS_OSX
      UIAccessibilityElement *element = [[UIAccessibilityElement alloc] initWithAccessibilityContainer:self];
      NSString *withN = [_accessibilityLabels.tableRow
          stringByReplacingOccurrencesOfString:@"{n}"
                                    withString:[NSString stringWithFormat:@"%lu", (unsigned long)(rowIndex + 1)]];
      element.accessibilityLabel =
          [withN stringByReplacingOccurrencesOfString:@"{content}"
                                           withString:[cellTexts componentsJoinedByString:@", "]];
      element.accessibilityFrameInContainerSpace = CGRectMake(0, yOffset, _totalTableWidth, rowHeight);
      element.accessibilityTraits =
          row.firstObject.isHeader ? UIAccessibilityTraitHeader : UIAccessibilityTraitStaticText;
      [elements addObject:element];
#else
      // TODO: Implement macOS VoiceOver support for table rows using NSAccessibility.
      // ENRMTableGridView draws the entire table in a single drawRect: pass, so AppKit
      // cannot discover cells automatically. Needs accessibilityRole, accessibilityChildren
      // (NSAccessibilityRowRole per row, NSAccessibilityCellRole per cell), and
      // accessibilityLabel populated from plainText on ENRMTableGridView.
#endif
    }
    yOffset += rowHeight;
  }
  _cachedAccessibilityElements = elements;
  return elements;
}

@end
