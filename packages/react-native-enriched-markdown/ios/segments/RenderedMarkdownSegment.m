#import "RenderedMarkdownSegment.h"
#import "MarkdownASTNode.h"

@implementation ENRMTextSegment
+ (instancetype)segmentWithNodes:(NSArray<MarkdownASTNode *> *)nodes
{
  NSParameterAssert(nodes != nil);
  ENRMTextSegment *segment = [[ENRMTextSegment alloc] init];
  segment.nodes = [nodes copy];
  return segment;
}
@end

@implementation ENRMTableSegment
+ (instancetype)segmentWithTableNode:(MarkdownASTNode *)node
{
  NSParameterAssert(node != nil);
  ENRMTableSegment *segment = [[ENRMTableSegment alloc] init];
  segment.tableNode = node;
  return segment;
}
@end

@implementation ENRMMathSegment
+ (instancetype)segmentWithLatex:(NSString *)latex
{
  NSParameterAssert(latex != nil);
  ENRMMathSegment *segment = [[ENRMMathSegment alloc] init];
  segment.latex = latex;
  return segment;
}
@end

@implementation ENRMCodeBlockSegment
+ (instancetype)segmentWithCodeBlockNode:(MarkdownASTNode *)node
{
  NSParameterAssert(node != nil);
  ENRMCodeBlockSegment *segment = [[ENRMCodeBlockSegment alloc] init];
  segment.codeBlockNode = node;
  return segment;
}
@end

@implementation ENRMBlockquoteSegment
+ (instancetype)segmentWithBlockquoteNode:(MarkdownASTNode *)node
{
  NSParameterAssert(node != nil);
  ENRMBlockquoteSegment *segment = [[ENRMBlockquoteSegment alloc] init];
  segment.blockquoteNode = node;
  return segment;
}
@end

@implementation ENRMVideoSegment
+ (instancetype)segmentWithVideoNode:(MarkdownASTNode *)node
{
  NSParameterAssert(node != nil);
  ENRMVideoSegment *segment = [[ENRMVideoSegment alloc] init];
  segment.videoNode = node;
  return segment;
}
@end

@implementation ENRMRenderedSegment
+ (instancetype)textSegmentWithResult:(ENRMRenderResult *)result signature:(uint64_t)signature
{
  NSParameterAssert(result != nil);
  ENRMRenderedSegment *segment = [[ENRMRenderedSegment alloc] init];
  segment.kind = ENRMSegmentKindText;
  segment.textResult = result;
  segment.signature = signature;
  return segment;
}

+ (instancetype)tableSegmentWithSegment:(ENRMTableSegment *)tableSegment signature:(uint64_t)signature
{
  NSParameterAssert(tableSegment != nil);
  ENRMRenderedSegment *segment = [[ENRMRenderedSegment alloc] init];
  segment.kind = ENRMSegmentKindTable;
  segment.tableSegment = tableSegment;
  segment.signature = signature;
  return segment;
}

+ (instancetype)mathSegmentWithSegment:(ENRMMathSegment *)mathSegment signature:(uint64_t)signature
{
  NSParameterAssert(mathSegment != nil);
  ENRMRenderedSegment *segment = [[ENRMRenderedSegment alloc] init];
  segment.kind = ENRMSegmentKindMath;
  segment.mathSegment = mathSegment;
  segment.signature = signature;
  return segment;
}

+ (instancetype)codeBlockSegmentWithSegment:(ENRMCodeBlockSegment *)codeBlockSegment signature:(uint64_t)signature
{
  NSParameterAssert(codeBlockSegment != nil);
  ENRMRenderedSegment *segment = [[ENRMRenderedSegment alloc] init];
  segment.kind = ENRMSegmentKindCodeBlock;
  segment.codeBlockSegment = codeBlockSegment;
  segment.signature = signature;
  return segment;
}

+ (instancetype)blockquoteSegmentWithSegment:(ENRMBlockquoteSegment *)blockquoteSegment signature:(uint64_t)signature
{
  NSParameterAssert(blockquoteSegment != nil);
  ENRMRenderedSegment *segment = [[ENRMRenderedSegment alloc] init];
  segment.kind = ENRMSegmentKindBlockquote;
  segment.blockquoteSegment = blockquoteSegment;
  segment.signature = signature;
  return segment;
}

+ (instancetype)videoSegmentWithSegment:(ENRMVideoSegment *)videoSegment signature:(uint64_t)signature
{
  NSParameterAssert(videoSegment != nil);
  ENRMRenderedSegment *segment = [[ENRMRenderedSegment alloc] init];
  segment.kind = ENRMSegmentKindVideo;
  segment.videoSegment = videoSegment;
  segment.signature = signature;
  return segment;
}
@end

// FNV-1a 64-bit hash for segment signatures. Collisions are theoretically
// possible but negligible for the small number of segments per document
// (~single digits). Worst case is a single skipped view update, corrected
// on the next streaming tick. This replaces the previous approach of building
// and comparing multi-KB NSString signatures from the full AST subtree.
static const uint64_t kFNVOffsetBasis = 14695981039346656037ULL;
static const uint64_t kFNVPrime = 1099511628211ULL;

static inline uint64_t fnvMixByte(uint64_t hash, uint8_t byte)
{
  hash ^= byte;
  hash *= kFNVPrime;
  return hash;
}

static inline uint64_t fnvMixUInt64(uint64_t hash, uint64_t value)
{
  for (int i = 0; i < 8; i++) {
    hash = fnvMixByte(hash, (uint8_t)(value & 0xFF));
    value >>= 8;
  }
  return hash;
}

static inline uint64_t fnvMixString(uint64_t hash, NSString *string)
{
  if (!string)
    return hash;
  const char *utf8 = [string UTF8String];
  while (*utf8) {
    hash = fnvMixByte(hash, (uint8_t)*utf8++);
  }
  return hash;
}

uint64_t ENRMSignatureForNode(MarkdownASTNode *node)
{
  if (!node)
    return kFNVOffsetBasis;

  uint64_t hash = kFNVOffsetBasis;
  hash = fnvMixUInt64(hash, (uint64_t)node.type);
  hash = fnvMixString(hash, node.content);

  NSArray *keys = [[node.attributes allKeys] sortedArrayUsingSelector:@selector(compare:)];
  for (NSString *key in keys) {
    hash = fnvMixString(hash, key);
    hash = fnvMixString(hash, node.attributes[key]);
  }

  for (MarkdownASTNode *child in node.children) {
    hash = fnvMixUInt64(hash, ENRMSignatureForNode(child));
  }

  return hash;
}

uint64_t ENRMSignatureForNodes(NSArray<MarkdownASTNode *> *nodes)
{
  uint64_t hash = kFNVOffsetBasis;
  for (MarkdownASTNode *node in nodes) {
    hash = fnvMixUInt64(hash, ENRMSignatureForNode(node));
  }
  return hash;
}
