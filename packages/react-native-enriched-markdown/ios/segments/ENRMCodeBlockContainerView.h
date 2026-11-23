#pragma once
#import "ENRMDynamicBlockProps.h"
#import "ENRMUIKit.h"
#import "StyleConfig.h"

@class MarkdownASTNode;

NS_ASSUME_NONNULL_BEGIN

typedef void (^ENRMCodeBlockCopyBlock)(NSString *code, NSString *language);
typedef void (^ENRMCodeBlockPressBlock)(NSString *code, NSString *language);

@interface ENRMCodeBlockContainerView : RCTUIView

- (instancetype)initWithConfig:(StyleConfig *)config;

- (void)applyCodeBlockNode:(MarkdownASTNode *)node;

- (CGFloat)measureHeight:(CGFloat)maxWidth;

// View-free height for the shadow-node measurement pass: the same height an
// instance's measureHeight: reports for the node, without building a view.
+ (CGFloat)measureHeightForCodeBlockNode:(MarkdownASTNode *)node config:(StyleConfig *)config;

@property (nonatomic, strong) StyleConfig *config;

// True until the closing fence arrives: highlighting is deferred and copying is
// disabled, while the header stays visible.
@property (nonatomic, assign) BOOL pending;

// Shared, runtime-mutable block props (context-menu gate, tap gate, copy labels)
// read live at use-time. Set to the root's shared instance at creation so a code
// block added after a toggle is born current. See ENRMDynamicBlockProps.
@property (nonatomic, strong) ENRMDynamicBlockProps *dynamicProps;

// Fired when the code is copied (header button, context-menu Copy, or the
// VoiceOver copy action); set by the host to bridge up to the JS onCopyPress
// event. Not fired for "Copy as Markdown".
@property (nonatomic, copy, nullable) ENRMCodeBlockCopyBlock onCopyPress;

// Bridges a whole-block tap (not the copy button) up to the JS onCodeBlockPress event.
@property (nonatomic, copy, nullable) ENRMCodeBlockPressBlock onCodeBlockPress;

@end

NS_ASSUME_NONNULL_END
