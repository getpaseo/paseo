#import "ENRMFeatureFlags.h"

#if ENRICHED_MARKDOWN_VIDEO

#import "ENRMVideoContainerView.h"
#import "MarkdownASTNode.h"
#import "PasteboardUtils.h"
#import <AVKit/AVKit.h>
#if TARGET_OS_OSX
#import "ENRMMenuAction.h"
#endif

static const CGFloat kDefaultVideoAspectRatio = 16.0 / 9.0;

static inline CGFloat ENRMVideoAspectRatio(StyleConfig *config)
{
  CGFloat aspectRatio = [config videoAspectRatio];
  return aspectRatio > 0 ? aspectRatio : kDefaultVideoAspectRatio;
}

#if !TARGET_OS_OSX

// A thin wrapper VC that hosts AVPlayerViewController as a child with correct
// containment. RNSScreen (react-native-screens) overrides
// shouldAutomaticallyForwardAppearanceMethods, so using our own intermediate VC
// lets us trigger appearance transitions explicitly and guarantees the player
// controls render.
@interface ENRMVideoHostController : UIViewController
@property (nonatomic, strong, readonly) AVPlayerViewController *playerViewController;
- (void)applyCornerRadius:(CGFloat)radius backgroundColor:(UIColor *)color;
@end

@implementation ENRMVideoHostController

- (void)viewDidLoad
{
  [super viewDidLoad];
  self.view.backgroundColor = [UIColor clearColor];

  _playerViewController = [[AVPlayerViewController alloc] init];
  _playerViewController.showsPlaybackControls = YES;
  _playerViewController.entersFullScreenWhenPlaybackBegins = NO;
  _playerViewController.exitsFullScreenWhenPlaybackEnds = YES;
  _playerViewController.view.layer.masksToBounds = YES;

  [self addChildViewController:_playerViewController];
  [self.view addSubview:_playerViewController.view];
  [_playerViewController didMoveToParentViewController:self];
}

- (void)applyCornerRadius:(CGFloat)radius backgroundColor:(UIColor *)color
{
  _playerViewController.view.layer.cornerRadius = radius;
  _playerViewController.view.backgroundColor = color ?: [UIColor blackColor];
}

- (void)viewDidLayoutSubviews
{
  [super viewDidLayoutSubviews];
  _playerViewController.view.frame = self.view.bounds;
}

@end

#endif // !TARGET_OS_OSX

// ===== iOS implementation =====

#if !TARGET_OS_OSX

static RCTUIView *ENRMCreatePlayIconOverlay(void)
{
  CGFloat size = 52;
  RCTUIView *circle = [[RCTUIView alloc] initWithFrame:CGRectMake(0, 0, size, size)];
  circle.userInteractionEnabled = NO;
  circle.layer.backgroundColor = [RCTUIColor colorWithWhite:0 alpha:0.5].CGColor;
  circle.layer.cornerRadius = size / 2.0;

  CGFloat inset = size * 0.3;
  CGFloat triLeft = inset + size * 0.04;
  CGFloat triTop = inset - size * 0.04;
  CGFloat triRight = size - inset + size * 0.04;
  CGFloat triMid = size / 2.0;

  UIBezierPath *triangle = [UIBezierPath bezierPath];
  [triangle moveToPoint:CGPointMake(triLeft, triTop)];
  BezierPathAddLine(triangle, CGPointMake(triRight, triMid));
  BezierPathAddLine(triangle, CGPointMake(triLeft, size - triTop));
  [triangle closePath];

  CAShapeLayer *triLayer = [CAShapeLayer layer];
  triLayer.path = triangle.CGPath;
  triLayer.fillColor = [RCTUIColor whiteColor].CGColor;
  [circle.layer addSublayer:triLayer];

  return circle;
}

@implementation ENRMVideoContainerView {
  ENRMVideoHostController *_hostController;
  RCTUIView *_playIconOverlay;
  NSString *_currentURL;
  BOOL _hostInstalled;
  BOOL _hasBeenTapped;
}

- (instancetype)initWithConfig:(StyleConfig *)config
{
  if (self = [super init]) {
    _config = config;
    _dynamicProps = [[ENRMDynamicBlockProps alloc] init];
    self.userInteractionEnabled = YES;

    _hostController = [[ENRMVideoHostController alloc] init];
    [_hostController loadViewIfNeeded];
    [_hostController applyCornerRadius:[config videoBorderRadius] backgroundColor:[config videoBackgroundColor]];
    [self addSubview:_hostController.view];

    _playIconOverlay = ENRMCreatePlayIconOverlay();
    _playIconOverlay.userInteractionEnabled = NO;
    [self addSubview:_playIconOverlay];

    UIContextMenuInteraction *contextMenu = [[UIContextMenuInteraction alloc] initWithDelegate:self];
    [_hostController.view addInteraction:contextMenu];
  }
  return self;
}

#pragma mark - Touch Forwarding

- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event
{
  if (!self.userInteractionEnabled || self.hidden || self.alpha < 0.01) {
    return nil;
  }
  if ([self pointInside:point withEvent:event]) {
    if (!_hasBeenTapped) {
      _hasBeenTapped = YES;
      _playIconOverlay.hidden = YES;
    }
    return [_hostController.view hitTest:[self convertPoint:point toView:_hostController.view] withEvent:event];
  }
  return nil;
}

#pragma mark - View Controller Containment

- (void)didMoveToWindow
{
  [super didMoveToWindow];
  if (self.window && !_hostInstalled) {
    UIViewController *parentVC = [self enrm_closestViewController];
    if (parentVC) {
      [parentVC addChildViewController:_hostController];
      [_hostController beginAppearanceTransition:YES animated:NO];
      [_hostController didMoveToParentViewController:parentVC];
      [_hostController endAppearanceTransition];
      _hostInstalled = YES;
    }
  } else if (!self.window && _hostInstalled) {
    [_hostController beginAppearanceTransition:NO animated:NO];
    [_hostController endAppearanceTransition];
    [_hostController willMoveToParentViewController:nil];
    [_hostController removeFromParentViewController];
    _hostInstalled = NO;
  }
}

- (UIViewController *)enrm_closestViewController
{
  UIResponder *responder = self.nextResponder;
  while (responder) {
    if ([responder isKindOfClass:[UIViewController class]]) {
      return (UIViewController *)responder;
    }
    responder = responder.nextResponder;
  }
  return nil;
}

#pragma mark - Style Updates

- (void)reapplyStyle
{
  [_hostController applyCornerRadius:[_config videoBorderRadius] backgroundColor:[_config videoBackgroundColor]];
}

#pragma mark - Video Loading

- (void)applyVideoNode:(MarkdownASTNode *)node
{
  NSString *url = [node.attributes objectForKey:@"url"];
  if (!url || [url isEqualToString:_currentURL]) {
    return;
  }
  _currentURL = [url copy];
  _hasBeenTapped = NO;
  _playIconOverlay.hidden = NO;

  AVPlayerViewController *playerVC = _hostController.playerViewController;
  [playerVC.player pause];

  NSURL *videoURL = [NSURL URLWithString:url];
  if (!videoURL) {
    playerVC.player = nil;
    return;
  }

  playerVC.player = [AVPlayer playerWithURL:videoURL];
}

#pragma mark - Layout & Measurement

- (void)layoutSubviews
{
  [super layoutSubviews];
  _hostController.view.frame = self.bounds;
  _playIconOverlay.center = CGPointMake(CGRectGetMidX(self.bounds), CGRectGetMidY(self.bounds));
}

- (CGFloat)measureHeight:(CGFloat)maxWidth
{
  return maxWidth / ENRMVideoAspectRatio(_config);
}

+ (CGFloat)measureHeightForVideoNode:(__unused MarkdownASTNode *)node
                              config:(StyleConfig *)config
                            maxWidth:(CGFloat)maxWidth
{
  return maxWidth / ENRMVideoAspectRatio(config);
}

#pragma mark - Context Menu

- (void)copyURLToPasteboard
{
  if (_currentURL.length > 0) {
    copyStringToPasteboard(_currentURL);
  }
}

- (void)copyMarkdownToPasteboard
{
  if (_currentURL.length > 0) {
    NSString *markdown;
    if ([_currentURL containsString:@"\""]) {
      markdown = [NSString stringWithFormat:@"<video src='%@' />", _currentURL];
    } else {
      markdown = [NSString stringWithFormat:@"<video src=\"%@\" />", _currentURL];
    }
    copyStringToPasteboard(markdown);
  }
}

- (UIContextMenuConfiguration *)contextMenuInteraction:(UIContextMenuInteraction *)interaction
                        configurationForMenuAtLocation:(CGPoint)location
{
  if (!self.dynamicProps.enableBlockContextMenu || _currentURL.length == 0) {
    return nil;
  }
  return [UIContextMenuConfiguration
      configurationWithIdentifier:nil
                  previewProvider:nil
                   actionProvider:^UIMenu *(NSArray<UIMenuElement *> *suggestedActions) {
                     UIAction *copyURL =
                         [UIAction actionWithTitle:self.dynamicProps.menuCopyLabel
                                             image:[RCTUIImage systemImageNamed:@"doc.on.doc"]
                                        identifier:nil
                                           handler:^(__kindof UIAction *action) { [self copyURLToPasteboard]; }];

                     UIAction *copyMarkdown =
                         [UIAction actionWithTitle:self.dynamicProps.menuCopyAsMarkdownLabel
                                             image:[RCTUIImage systemImageNamed:@"doc.text"]
                                        identifier:nil
                                           handler:^(__kindof UIAction *action) { [self copyMarkdownToPasteboard]; }];

                     return [UIMenu menuWithTitle:@"" children:@[ copyURL, copyMarkdown ]];
                   }];
}

#pragma mark - Cleanup

- (void)dealloc
{
  [_hostController.playerViewController.player pause];
  _hostController.playerViewController.player = nil;
  [_hostController beginAppearanceTransition:NO animated:NO];
  [_hostController endAppearanceTransition];
  [_hostController willMoveToParentViewController:nil];
  [_hostController removeFromParentViewController];
}

@end

#else // TARGET_OS_OSX

// ===== macOS implementation =====

@implementation ENRMVideoContainerView {
  AVPlayerView *_playerView;
  NSString *_currentURL;
}

- (instancetype)initWithConfig:(StyleConfig *)config
{
  if (self = [super init]) {
    _config = config;
    _dynamicProps = [[ENRMDynamicBlockProps alloc] init];
    self.wantsLayer = YES;

    _playerView = [[AVPlayerView alloc] init];
    _playerView.controlsStyle = AVPlayerViewControlsStyleInline;
    _playerView.wantsLayer = YES;
    _playerView.layer.masksToBounds = YES;
    _playerView.layer.cornerRadius = [config videoBorderRadius];
    _playerView.layer.backgroundColor = ([config videoBackgroundColor] ?: [NSColor blackColor]).CGColor;
    [self addSubview:_playerView];
  }
  return self;
}

- (BOOL)isFlipped
{
  return YES;
}

#pragma mark - Style Updates

- (void)reapplyStyle
{
  _playerView.layer.cornerRadius = [_config videoBorderRadius];
  _playerView.layer.backgroundColor = ([_config videoBackgroundColor] ?: [NSColor blackColor]).CGColor;
}

#pragma mark - Video Loading

- (void)applyVideoNode:(MarkdownASTNode *)node
{
  NSString *url = [node.attributes objectForKey:@"url"];
  if (!url || [url isEqualToString:_currentURL]) {
    return;
  }
  _currentURL = [url copy];

  [_playerView.player pause];

  NSURL *videoURL = [NSURL URLWithString:url];
  if (!videoURL) {
    _playerView.player = nil;
    return;
  }

  _playerView.player = [AVPlayer playerWithURL:videoURL];
}

#pragma mark - Layout & Measurement

- (void)layout
{
  [super layout];
  _playerView.frame = self.bounds;
}

- (CGFloat)measureHeight:(CGFloat)maxWidth
{
  return maxWidth / ENRMVideoAspectRatio(_config);
}

+ (CGFloat)measureHeightForVideoNode:(__unused MarkdownASTNode *)node
                              config:(StyleConfig *)config
                            maxWidth:(CGFloat)maxWidth
{
  return maxWidth / ENRMVideoAspectRatio(config);
}

#pragma mark - Context Menu

- (void)copyURLToPasteboard
{
  if (_currentURL.length > 0) {
    copyStringToPasteboard(_currentURL);
  }
}

- (void)copyMarkdownToPasteboard
{
  if (_currentURL.length > 0) {
    NSString *markdown;
    if ([_currentURL containsString:@"\""]) {
      markdown = [NSString stringWithFormat:@"<video src='%@' />", _currentURL];
    } else {
      markdown = [NSString stringWithFormat:@"<video src=\"%@\" />", _currentURL];
    }
    copyStringToPasteboard(markdown);
  }
}

- (NSMenu *)menuForEvent:(NSEvent *)event
{
  if (!self.dynamicProps.enableBlockContextMenu || _currentURL.length == 0) {
    return [super menuForEvent:event];
  }
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@""];
  [menu addItem:ENRMCreateMenuItem(self.dynamicProps.menuCopyLabel, ^{ [self copyURLToPasteboard]; })];
  [menu addItem:ENRMCreateMenuItem(self.dynamicProps.menuCopyAsMarkdownLabel, ^{ [self copyMarkdownToPasteboard]; })];
  return menu;
}

#pragma mark - Cleanup

- (void)dealloc
{
  [_playerView.player pause];
  _playerView.player = nil;
}

@end

#endif // TARGET_OS_OSX

#endif // ENRICHED_MARKDOWN_VIDEO
