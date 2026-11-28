#pragma once
#import "NodeRenderer.h"

@class RendererFactory;
@class StyleConfig;
@class RenderContext;
@class MarkdownASTNode;

/// Shared base for all node renderers — provides `_rendererFactory` and `_config`
/// as protected ivars and the common designated initializer.
/// `renderNode:into:context:` is a template method: take context snapshot ->
/// `renderNodeContent:into:context:` -> restore snapshot. Subclasses implement
/// `renderNodeContent:into:context:` and, when they mutate scoped context state,
/// override `takeContextSnapshot:` to return `[context snapshotScope]`.
@interface BaseRenderer : NSObject <NodeRenderer> {
@protected
  __weak RendererFactory *_rendererFactory;
  StyleConfig *_config;
}

- (instancetype)initWithRendererFactory:(id)rendererFactory config:(id)config;

- (void)renderNodeContent:(MarkdownASTNode *)node
                     into:(NSMutableAttributedString *)output
                  context:(RenderContext *)context;

/// Default returns nil.
- (nullable id)takeContextSnapshot:(RenderContext *)context;

/// Default restores a scope frame when snapshot is non-nil, no-op otherwise.
- (void)restoreContextSnapshot:(nullable id)snapshot context:(RenderContext *)context;

@end
