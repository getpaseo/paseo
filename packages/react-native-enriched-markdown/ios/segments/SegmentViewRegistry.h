#pragma once

#import "ENRMUIKit.h"
#import "RenderedMarkdownSegment.h"

NS_ASSUME_NONNULL_BEGIN

typedef BOOL (^ENRMSegmentMatchesViewBlock)(RCTUIView *view, ENRMRenderedSegment *segment);
typedef RCTUIView *_Nonnull (^ENRMSegmentCreateViewBlock)(ENRMRenderedSegment *segment);
typedef void (^ENRMSegmentUpdateViewBlock)(RCTUIView *view, ENRMRenderedSegment *segment);

@interface ENRMSegmentViewHandler : NSObject

@property (nonatomic, assign, readonly) ENRMSegmentKind kind;
@property (nonatomic, copy, readonly) ENRMSegmentMatchesViewBlock matchesView;
@property (nonatomic, copy, readonly) ENRMSegmentCreateViewBlock createView;
@property (nonatomic, copy, readonly) ENRMSegmentUpdateViewBlock updateView;

+ (instancetype)handlerWithKind:(ENRMSegmentKind)kind
                    matchesView:(ENRMSegmentMatchesViewBlock)matchesView
                     createView:(ENRMSegmentCreateViewBlock)createView
                     updateView:(ENRMSegmentUpdateViewBlock)updateView;

@end

@interface ENRMSegmentViewRegistry : NSObject

- (instancetype)initWithHandlers:(NSArray<ENRMSegmentViewHandler *> *)handlers;

- (BOOL)view:(RCTUIView *)view matchesSegment:(ENRMRenderedSegment *)segment;
- (RCTUIView *)createViewForSegment:(ENRMRenderedSegment *)segment;
- (void)updateView:(RCTUIView *)view withSegment:(ENRMRenderedSegment *)segment;

@end

NS_ASSUME_NONNULL_END
