#import "ENRMUIKit.h"
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, ENRMEditPhase) {
  ENRMEditPhaseIdle,
  ENRMEditPhaseProcessing,
  ENRMEditPhaseFormatting,
  ENRMEditPhaseImporting,
};

/// Tracks the current editing phase and exposes computed suppression queries.
/// Replaces the scattered boolean flags (`_isApplyingFormatting`, `_isTextChanging`,
/// `blockEmitting`, `_lastTextChangeTime`) that previously guarded re-entrant
/// code paths in the view.
@interface ENRMEditSession : NSObject

@property (nonatomic, readonly) ENRMEditPhase phase;

- (instancetype)initWithTextView:(ENRMPlatformTextView *)textView;

- (void)enterPhase:(ENRMEditPhase)newPhase;
- (void)exitPhase;

- (void)recordTextChange;

@property (nonatomic, readonly) BOOL isComposing;
@property (nonatomic, readonly) BOOL isPostEditGracePeriod;
@property (nonatomic, readonly) BOOL shouldSuppressFormatting;
@property (nonatomic, readonly) BOOL shouldSuppressEvents;
@property (nonatomic, readonly) BOOL shouldSuppressSelectionSideEffects;

@end

NS_ASSUME_NONNULL_END
