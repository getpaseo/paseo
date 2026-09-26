// titlebar-drag-mouse.m — native mouse helper for the titlebar-drag harness.
// Posts real CGEvents (kCGHIDEventTap) so a drag moves the actual window; pure
// CDP input would never exercise Electron's draggable-region pipeline.
// Usage: titlebar-drag-mouse drag x1 y1 x2 y2 | click x y
// Every event carries flags 0 so a user-held Cmd/Opt cannot leak into the drag.
// Exit 2 when this process lacks Accessibility trust: the harness fails loudly
// instead of posting nothing and reading as a pass.
#import <ApplicationServices/ApplicationServices.h>
#import <stdio.h>
#import <stdlib.h>
#import <string.h>
#import <unistd.h>

static void post(CGEventType type, CGPoint p, useconds_t delay) {
  CGEventRef event = CGEventCreateMouseEvent(NULL, type, p, kCGMouseButtonLeft);
  if (!event) {
    fprintf(stderr, "mouse: CGEventCreateMouseEvent failed\n");
    exit(3);
  }
  CGEventSetFlags(event, (CGEventFlags)0);
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  usleep(delay);
}

int main(int argc, char **argv) {
  if (!AXIsProcessTrusted()) {
    fprintf(stderr, "mouse: not accessibility-trusted\n");
    return 2;
  }
  if (argc == 6 && strcmp(argv[1], "drag") == 0) {
    CGPoint a = {atof(argv[2]), atof(argv[3])};
    CGPoint b = {atof(argv[4]), atof(argv[5])};
    post(kCGEventMouseMoved, a, 150000);
    post(kCGEventLeftMouseDown, a, 150000);
    for (int i = 1; i <= 20; i++) {
      CGPoint step = {a.x + (b.x - a.x) * i / 20, a.y + (b.y - a.y) * i / 20};
      post(kCGEventLeftMouseDragged, step, 25000);
    }
    post(kCGEventLeftMouseUp, b, 25000);
    return 0;
  }
  if (argc == 4 && strcmp(argv[1], "click") == 0) {
    CGPoint p = {atof(argv[2]), atof(argv[3])};
    post(kCGEventMouseMoved, p, 150000);
    post(kCGEventLeftMouseDown, p, 150000);
    post(kCGEventLeftMouseUp, p, 25000);
    return 0;
  }
  fprintf(stderr, "usage: %s drag x1 y1 x2 y2 | click x y\n", argv[0]);
  return 1;
}
