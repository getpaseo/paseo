#pragma once
#import <Foundation/Foundation.h>

#import "ENRMLatexErrorReporting.h"

NS_ASSUME_NONNULL_BEGIN

/// Returns YES when the error was delivered to a live event emitter, NO when it
/// must be queued and flushed once an emitter is attached.
typedef BOOL (^ENRMLatexErrorEmit)(NSString *source, NSString *message, BOOL displayMode);

/// Shared LaTeX-error plumbing for both host views. Owns the dedup set and the
/// pending queue and wires reporters; the only per-view difference - casting
/// `_eventEmitter` to the concrete type - stays in the `emit` block each view
/// supplies.
@interface ENRMLatexErrorCoordinator : NSObject

- (instancetype)initWithEmit:(ENRMLatexErrorEmit)emit NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

- (void)wireReporters:(NSArray<id<ENRMLatexErrorReporting>> *)reporters;
- (void)reportSource:(NSString *)source message:(NSString *)message displayMode:(BOOL)displayMode;
- (void)flushPending;

@end

NS_ASSUME_NONNULL_END
