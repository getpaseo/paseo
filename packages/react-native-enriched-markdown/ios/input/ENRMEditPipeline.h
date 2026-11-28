#import "ENRMInputBlockType.h"
#import <Foundation/Foundation.h>

@class ENRMBlockStore;
@class ENRMFormattingStore;
@class ENRMInputFormatter;
@class ENRMDetectorPipeline;
@class ENRMBlockRange;

NS_ASSUME_NONNULL_BEGIN

/// Immutable snapshot of everything the pipeline needs to process a single text change.
@interface ENRMEditContext : NSObject
@property (nonatomic, readonly) NSUInteger editLocation;
@property (nonatomic, readonly) NSUInteger deletedLength;
@property (nonatomic, readonly) NSUInteger insertedLength;
@property (nonatomic, readonly) BOOL preEditReplacedNewline;
@property (nonatomic, readonly) ENRMInputBlockType preEditBlockType;
@property (nonatomic, readonly) NSInteger preEditBlockLevel;
@property (nonatomic, readonly) BOOL preEditParagraphWasEmpty;
@property (nonatomic, readonly) NSSet<NSNumber *> *pendingStyles;
@property (nonatomic, readonly) NSSet<NSNumber *> *pendingStyleRemovals;

- (instancetype)initWithEditLocation:(NSUInteger)editLocation
                       deletedLength:(NSUInteger)deletedLength
                      insertedLength:(NSUInteger)insertedLength
              preEditReplacedNewline:(BOOL)preEditReplacedNewline
                    preEditBlockType:(ENRMInputBlockType)preEditBlockType
                   preEditBlockLevel:(NSInteger)preEditBlockLevel
            preEditParagraphWasEmpty:(BOOL)preEditParagraphWasEmpty
                       pendingStyles:(NSSet<NSNumber *> *)pendingStyles
                pendingStyleRemovals:(NSSet<NSNumber *> *)pendingStyleRemovals;
@end

/// View-specific operations the pipeline delegates back to its host.
@protocol ENRMEditPipelineHost <NSObject>
- (NSString *)plainText;
- (NSTextStorage *)textStorage;
@end

/// Orchestrates the data-model phases of the per-keystroke edit pipeline:
/// store adjustment, orphan pruning, pending styles, and block continuation.
///
/// Formatting (which needs `_textView`, `_formatterStyle`, `ENRMEditPhaseFormatting`)
/// and UI updates (typing attributes, placeholder, events, height) stay on the view.
/// The pipeline tells the view whether the edit touched a newline so the view can
/// pick full vs scoped formatting.
@interface ENRMEditPipeline : NSObject

- (instancetype)initWithFormattingStore:(ENRMFormattingStore *)formattingStore
                             blockStore:(ENRMBlockStore *)blockStore
                              formatter:(ENRMInputFormatter *)formatter
                       detectorPipeline:(ENRMDetectorPipeline *)detectorPipeline
                                   host:(id<ENRMEditPipelineHost>)host;

/// Runs the data-model phases of the edit pipeline and returns YES if the edit
/// touched a newline (so the view should do a full-document reformat rather than
/// a scoped one).
- (BOOL)processTextChangeWithContext:(ENRMEditContext *)context;

/// Drops anchored blocks no longer at a line start. Exposed so the view's
/// `adjustStoresForEditAtLocation:` can call it too.
- (void)pruneOrphanedBlockAnchors;

/// Adjusts both stores for an edit delta, prunes orphans, normalizes.
/// Exposed for the view's programmatic text-mutation path.
- (NSString *)adjustStoresForEditAtLocation:(NSUInteger)editLocation
                              deletedLength:(NSUInteger)deletedLength
                             insertedLength:(NSUInteger)insertedLength;

/// Runs the detector pipeline on the edited portion of the text.
- (void)detectLinksAtLocation:(NSUInteger)editLocation insertedLength:(NSUInteger)insertedLength;

@end

NS_ASSUME_NONNULL_END
