#import "ENRMAsyncRenderCoordinator.h"

@implementation ENRMAsyncRenderCoordinator {
  dispatch_queue_t _queue;
  NSUInteger _currentRenderId;
}

- (instancetype)initWithQueueLabel:(const char *)label
{
  if (self = [super init]) {
    _queue = dispatch_queue_create(label, DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (void)scheduleRender:(BOOL (^)(void))renderBlock apply:(dispatch_block_t)applyBlock
{
  if (_blockAsyncRender)
    return;
  NSUInteger renderId = ++_currentRenderId;
  dispatch_async(_queue, ^{
    if (!renderBlock())
      return;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (renderId == self->_currentRenderId) {
        applyBlock();
      }
    });
  });
}

- (void)invalidate
{
  ++_currentRenderId;
}

@end
