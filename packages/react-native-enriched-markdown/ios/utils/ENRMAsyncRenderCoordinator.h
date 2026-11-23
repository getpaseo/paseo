#pragma once
#import <Foundation/Foundation.h>

/// Owns the serial render queue and render-ID counter used by async render pipelines.
/// Handles stale-result cancellation and main-thread dispatch automatically.
/// Set blockAsyncRender = YES before synchronous rendering to suppress queued dispatches.
@interface ENRMAsyncRenderCoordinator : NSObject

@property (nonatomic) BOOL blockAsyncRender;

- (instancetype)initWithQueueLabel:(const char *)label NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

/// Dispatches renderBlock on the serial queue.
/// If renderBlock returns YES, applyBlock is dispatched on the main queue,
/// provided the render ID has not been superseded by a newer call.
- (void)scheduleRender:(BOOL (^)(void))renderBlock apply:(dispatch_block_t)applyBlock;

/// Advances the render ID so any in-flight render's apply block is discarded
/// by the renderId == currentRenderId check when it lands on the main queue.
/// Use before recycling or otherwise resetting a host that owns this coordinator.
- (void)invalidate;

@end
