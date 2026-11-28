#import "ENRMParticleOverlayView.h"
#import <QuartzCore/QuartzCore.h>

static const CGFloat kDefaultParticleDensity = 8.0;
static const CGFloat kDefaultParticleSpeed = 20.0;
static const CGFloat kDotImageSize = 6.0;
static const CGFloat kRevealVelocityMultiplier = 10.0;
static const CGFloat kRevealAlphaSpeedMultiplier = 6.0;

static const CGFloat kDot1BirthRateMin = 3.0;
static const CGFloat kDot1BirthRatePerArea = 0.013;
static const CGFloat kDot1Lifetime = 1.6;
static const CGFloat kDot1Velocity = 8.0;
static const CGFloat kDot1Scale = 0.25;
static const CGFloat kDot1AlphaSpeed = -0.25;

static const CGFloat kDot2BirthRateMin = 1.5;
static const CGFloat kDot2BirthRatePerArea = 0.007;
static const CGFloat kDot2Lifetime = 1.2;
static const CGFloat kDot2Velocity = 12.0;
static const CGFloat kDot2Scale = 0.18;
static const CGFloat kDot2AlphaSpeed = -0.3;

static const CGFloat kMaxParticleLifetime = 1.6; // must match the longest lifetime above

static CGImageRef sharedDotCGImage(void)
{
  static CGImageRef cgImage;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(NULL, (size_t)kDotImageSize, (size_t)kDotImageSize, 8, 0, space,
                                             kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(space);
    CGContextSetRGBFillColor(ctx, 1, 1, 1, 1);
    CGContextFillEllipseInRect(ctx, CGRectMake(0, 0, kDotImageSize, kDotImageSize));
    cgImage = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
  });
  return cgImage;
}

@implementation ENRMParticleOverlayView {
  CAEmitterLayer *_emitterLayer;
  RCTUIColor *_particleColor;
  CGFloat _particleDensity;
  CGFloat _particleSpeed;
}

- (instancetype)initWithConfig:(StyleConfig *)config charRange:(NSRange)charRange
{
  if (self = [super initWithCharRange:charRange]) {
    _particleColor = [config spoilerColor];
    _particleDensity = [config spoilerParticleDensity];
    _particleSpeed = [config spoilerParticleSpeed];
  }
  return self;
}

#pragma mark - Overrides

- (void)didAttachToSuperview
{
  self.layer.backgroundColor = [self resolveBackgroundCGColor];
  if (!_emitterLayer) {
    [self setupEmitter];
  }
}

- (void)didLayoutOverlay
{
  if (!_emitterLayer) {
    // Emitter creation is deferred when bounds were zero at attach time.
    [self setupEmitter];
    return;
  }
  if (!self.revealing) {
    _emitterLayer.frame = self.bounds;
    _emitterLayer.emitterPosition = CGPointMake(self.bounds.size.width / 2.0, self.bounds.size.height / 2.0);
    _emitterLayer.emitterSize = self.bounds.size;
  }
}

- (void)prepareRevealAnimation
{
  _emitterLayer.birthRate = 0;

  for (CAEmitterCell *cell in _emitterLayer.emitterCells) {
    NSString *velocityPath = [NSString stringWithFormat:@"emitterCells.%@.velocity", cell.name];
    NSString *alphaPath = [NSString stringWithFormat:@"emitterCells.%@.alphaSpeed", cell.name];
    [_emitterLayer setValue:@(cell.velocity * kRevealVelocityMultiplier) forKeyPath:velocityPath];
    [_emitterLayer setValue:@(cell.alphaSpeed * kRevealAlphaSpeedMultiplier) forKeyPath:alphaPath];
  }
}

#pragma mark - Emitter setup

- (CAEmitterCell *)makeParticleCellWithName:(NSString *)name
                                  birthRate:(CGFloat)birthRate
                                   lifetime:(CGFloat)lifetime
                                   velocity:(CGFloat)velocity
                                      scale:(CGFloat)scale
                                 alphaSpeed:(CGFloat)alphaSpeed
{
  CAEmitterCell *cell = [CAEmitterCell emitterCell];
  cell.name = name;
  cell.contents = (__bridge id)sharedDotCGImage();
  cell.color = _particleColor.CGColor;
  cell.birthRate = birthRate;
  cell.lifetime = lifetime;
  cell.lifetimeRange = lifetime * 0.3;
  cell.velocity = velocity;
  cell.velocityRange = velocity * 0.5;
  cell.emissionRange = M_PI * 2;
  cell.scale = scale;
  cell.scaleRange = scale * 0.3;
  cell.alphaRange = 0.2;
  cell.alphaSpeed = alphaSpeed;
  return cell;
}

- (void)setupEmitter
{
  CGRect bounds = self.bounds;
  if (bounds.size.width <= 0 || bounds.size.height <= 0)
    return;

  CGFloat area = bounds.size.width * bounds.size.height;
  CGFloat densityFactor = _particleDensity / kDefaultParticleDensity;
  CGFloat speedFactor = _particleSpeed / kDefaultParticleSpeed;

  _emitterLayer = [CAEmitterLayer layer];
  _emitterLayer.emitterShape = kCAEmitterLayerRectangle;
  _emitterLayer.renderMode = kCAEmitterLayerOldestLast;
  _emitterLayer.frame = bounds;
  _emitterLayer.emitterPosition = CGPointMake(bounds.size.width / 2.0, bounds.size.height / 2.0);
  _emitterLayer.emitterSize = bounds.size;
  _emitterLayer.emitterCells = @[
    [self makeParticleCellWithName:@"dot1"
                         birthRate:MAX(kDot1BirthRateMin, area * kDot1BirthRatePerArea * densityFactor)
                          lifetime:kDot1Lifetime
                          velocity:kDot1Velocity * speedFactor
                             scale:kDot1Scale
                        alphaSpeed:kDot1AlphaSpeed],
    [self makeParticleCellWithName:@"dot2"
                         birthRate:MAX(kDot2BirthRateMin, area * kDot2BirthRatePerArea * densityFactor)
                          lifetime:kDot2Lifetime
                          velocity:kDot2Velocity * speedFactor
                             scale:kDot2Scale
                        alphaSpeed:kDot2AlphaSpeed],
  ];

  // Backdate the emitter so it appears pre-populated with particles.
  _emitterLayer.beginTime = CACurrentMediaTime() - kMaxParticleLifetime;

  [self.layer addSublayer:_emitterLayer];
}

@end
