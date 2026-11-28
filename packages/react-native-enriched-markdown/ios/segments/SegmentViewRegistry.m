#import "SegmentViewRegistry.h"

@implementation ENRMSegmentViewHandler

+ (instancetype)handlerWithKind:(ENRMSegmentKind)kind
                    matchesView:(ENRMSegmentMatchesViewBlock)matchesView
                     createView:(ENRMSegmentCreateViewBlock)createView
                     updateView:(ENRMSegmentUpdateViewBlock)updateView
{
  ENRMSegmentViewHandler *handler = [[ENRMSegmentViewHandler alloc] init];
  handler->_kind = kind;
  handler->_matchesView = [matchesView copy];
  handler->_createView = [createView copy];
  handler->_updateView = [updateView copy];
  return handler;
}

@end

@implementation ENRMSegmentViewRegistry {
  NSDictionary<NSNumber *, ENRMSegmentViewHandler *> *_handlersByKind;
}

- (instancetype)initWithHandlers:(NSArray<ENRMSegmentViewHandler *> *)handlers
{
  if (self = [super init]) {
    NSMutableDictionary<NSNumber *, ENRMSegmentViewHandler *> *handlersByKind = [NSMutableDictionary dictionary];
    for (ENRMSegmentViewHandler *handler in handlers) {
      handlersByKind[@(handler.kind)] = handler;
    }
    _handlersByKind = [handlersByKind copy];
  }
  return self;
}

- (nullable ENRMSegmentViewHandler *)handlerForSegment:(ENRMRenderedSegment *)segment
{
  return _handlersByKind[@(segment.kind)];
}

- (BOOL)view:(RCTUIView *)view matchesSegment:(ENRMRenderedSegment *)segment
{
  ENRMSegmentViewHandler *handler = [self handlerForSegment:segment];
  NSAssert(handler != nil, @"Missing segment view handler for kind %ld", (long)segment.kind);
  return handler != nil && handler.matchesView(view, segment);
}

- (RCTUIView *)createViewForSegment:(ENRMRenderedSegment *)segment
{
  ENRMSegmentViewHandler *handler = [self handlerForSegment:segment];
  NSAssert(handler != nil, @"Missing segment view handler for kind %ld", (long)segment.kind);
  if (!handler) {
    return [[RCTUIView alloc] init];
  }
  return handler.createView(segment);
}

- (void)updateView:(RCTUIView *)view withSegment:(ENRMRenderedSegment *)segment
{
  ENRMSegmentViewHandler *handler = [self handlerForSegment:segment];
  NSAssert(handler != nil, @"Missing segment view handler for kind %ld", (long)segment.kind);
  if (handler && handler.matchesView(view, segment)) {
    handler.updateView(view, segment);
  }
}

@end
