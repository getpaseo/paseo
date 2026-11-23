#import "BaseRenderer.h"
#import "RenderContext.h"
#import "RendererFactory.h"
#import "StyleConfig.h"

@implementation BaseRenderer

- (instancetype)initWithRendererFactory:(id)rendererFactory config:(id)config
{
  if (self = [super init]) {
    _rendererFactory = rendererFactory;
    _config = (StyleConfig *)config;
  }
  return self;
}

- (void)renderNode:(MarkdownASTNode *)node into:(NSMutableAttributedString *)output context:(RenderContext *)context
{
  id snapshot = [self takeContextSnapshot:context];
  @try {
    [self renderNodeContent:node into:output context:context];
  } @finally {
    [self restoreContextSnapshot:snapshot context:context];
  }
}

- (void)renderNodeContent:(MarkdownASTNode *)node
                     into:(NSMutableAttributedString *)output
                  context:(RenderContext *)context
{
  [self doesNotRecognizeSelector:_cmd];
}

- (id)takeContextSnapshot:(RenderContext *)context
{
  return nil;
}

- (void)restoreContextSnapshot:(id)snapshot context:(RenderContext *)context
{
  if (snapshot) {
    [context restoreScope:snapshot];
  }
}

@end
