#pragma once

#import "ENRMInputDecorationDrawer.h"
#import "ENRMUIKit.h"

NS_ASSUME_NONNULL_BEGIN

@class ENRMInputListMarkerDrawer;

/// Thin orchestrator that iterates registered decoration drawers during the draw pass.
@interface ENRMInputLayoutManager : NSLayoutManager

@property (nonatomic, strong, readonly) ENRMInputListMarkerDrawer *listMarkerDrawer;
@property (nonatomic, copy) NSArray<id<ENRMInputDecorationDrawer>> *decorationDrawers;

- (void)drawEmptyEditorDecorationsWithInset:(UIEdgeInsets)inset;

@end

NS_ASSUME_NONNULL_END
