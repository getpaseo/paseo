#import "BaseRenderer.h"

@class RendererFactory;
@class StyleConfig;
@class RenderContext;

@interface ListRenderer : BaseRenderer

- (instancetype)initWithRendererFactory:(RendererFactory *)rendererFactory
                                 config:(StyleConfig *)config
                              isOrdered:(BOOL)isOrdered;

@end
