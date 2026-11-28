#import "ENRMSVGPath.h"
#import <math.h>

// Minimal SVG path `d` parser producing a CGPath. It is intentionally scoped to
// the command set the admonition octicons use (M m L l H h V v C c S s Q q T t
// A a Z z); it is not a general-purpose SVG engine. The parser walks the string
// with a scanner, tracking the current point, the current subpath start, and the
// previous control point (for the smooth S/T shorthands). Elliptical arcs are
// converted to cubic beziers via the endpoint -> center parameterization from
// the SVG implementation notes (appendix F.6).

typedef struct {
  const char *chars;
  NSUInteger length;
  NSUInteger index;
} ENRMScanner;

static BOOL ENRMScanIsCommand(char c)
{
  switch (c) {
    case 'M':
    case 'm':
    case 'L':
    case 'l':
    case 'H':
    case 'h':
    case 'V':
    case 'v':
    case 'C':
    case 'c':
    case 'S':
    case 's':
    case 'Q':
    case 'q':
    case 'T':
    case 't':
    case 'A':
    case 'a':
    case 'Z':
    case 'z':
      return YES;
    default:
      return NO;
  }
}

static void ENRMScanSkipSeparators(ENRMScanner *s)
{
  while (s->index < s->length) {
    char c = s->chars[s->index];
    if (c == ' ' || c == ',' || c == '\t' || c == '\n' || c == '\r') {
      s->index++;
    } else {
      break;
    }
  }
}

// Reads the next number. SVG allows numbers to run together without separators
// (e.g. "1 1 0 1 1"), and a leading '-' or '.' starts a new number even with no
// separator (e.g. "16 0Zm8-6.5"). Returns NO when no number is available.
static BOOL ENRMScanNumber(ENRMScanner *s, double *out)
{
  ENRMScanSkipSeparators(s);
  NSUInteger start = s->index;
  BOOL seenDigit = NO;
  BOOL seenDot = NO;
  BOOL seenExp = NO;

  if (s->index < s->length && (s->chars[s->index] == '+' || s->chars[s->index] == '-')) {
    s->index++;
  }
  while (s->index < s->length) {
    char c = s->chars[s->index];
    if (c >= '0' && c <= '9') {
      seenDigit = YES;
      s->index++;
    } else if (c == '.' && !seenDot && !seenExp) {
      seenDot = YES;
      s->index++;
    } else if ((c == 'e' || c == 'E') && seenDigit && !seenExp) {
      seenExp = YES;
      s->index++;
      if (s->index < s->length && (s->chars[s->index] == '+' || s->chars[s->index] == '-')) {
        s->index++;
      }
    } else {
      break;
    }
  }

  if (!seenDigit) {
    s->index = start;
    return NO;
  }

  char buffer[64];
  NSUInteger count = s->index - start;
  if (count >= sizeof(buffer)) {
    count = sizeof(buffer) - 1;
  }
  memcpy(buffer, s->chars + start, count);
  buffer[count] = '\0';
  *out = atof(buffer);
  return YES;
}

// A single arc segment (<= 90 degrees) approximated as one cubic bezier.
static void ENRMArcSegment(CGMutablePathRef path, double cx, double cy, double rx, double ry, double phi, double t1,
                           double dt)
{
  double cosPhi = cos(phi);
  double sinPhi = sin(phi);
  double alpha = (4.0 / 3.0) * tan(dt / 4.0);

  double x1 = cos(t1);
  double y1 = sin(t1);
  double x2 = cos(t1 + dt);
  double y2 = sin(t1 + dt);

  double p1x = cx + rx * cosPhi * x1 - ry * sinPhi * y1;
  double p1y = cy + rx * sinPhi * x1 + ry * cosPhi * y1;
  double p2x = cx + rx * cosPhi * x2 - ry * sinPhi * y2;
  double p2y = cy + rx * sinPhi * x2 + ry * cosPhi * y2;

  double d1x = -rx * cosPhi * y1 - ry * sinPhi * x1;
  double d1y = -rx * sinPhi * y1 + ry * cosPhi * x1;
  double d2x = -rx * cosPhi * y2 - ry * sinPhi * x2;
  double d2y = -rx * sinPhi * y2 + ry * cosPhi * x2;

  CGPathAddCurveToPoint(path, NULL, (CGFloat)(p1x + alpha * d1x), (CGFloat)(p1y + alpha * d1y),
                        (CGFloat)(p2x - alpha * d2x), (CGFloat)(p2y - alpha * d2y), (CGFloat)p2x, (CGFloat)p2y);
}

// Endpoint -> center parameterization, then split into <=90 degree bezier arcs.
static void ENRMAppendArc(CGMutablePathRef path, double x0, double y0, double rx, double ry, double xAxisRotationDeg,
                          BOOL largeArc, BOOL sweep, double x, double y)
{
  if (rx == 0.0 || ry == 0.0) {
    CGPathAddLineToPoint(path, NULL, (CGFloat)x, (CGFloat)y);
    return;
  }

  rx = fabs(rx);
  ry = fabs(ry);
  double phi = xAxisRotationDeg * M_PI / 180.0;
  double cosPhi = cos(phi);
  double sinPhi = sin(phi);

  double dx = (x0 - x) / 2.0;
  double dy = (y0 - y) / 2.0;
  double x1p = cosPhi * dx + sinPhi * dy;
  double y1p = -sinPhi * dx + cosPhi * dy;

  // Scale up the radii if they are too small to span the endpoints.
  double lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1.0) {
    double scale = sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }

  double num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  double den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  double factor = den == 0.0 ? 0.0 : sqrt(fmax(0.0, num / den));
  if (largeArc == sweep) {
    factor = -factor;
  }

  double cxp = factor * (rx * y1p / ry);
  double cyp = factor * (-ry * x1p / rx);
  double cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2.0;
  double cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2.0;

  double startAngle = atan2((y1p - cyp) / ry, (x1p - cxp) / rx);
  double endAngle = atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx);
  double delta = endAngle - startAngle;

  if (!sweep && delta > 0.0) {
    delta -= 2.0 * M_PI;
  } else if (sweep && delta < 0.0) {
    delta += 2.0 * M_PI;
  }

  int segments = (int)ceil(fabs(delta) / (M_PI / 2.0));
  if (segments < 1) {
    segments = 1;
  }
  double segDelta = delta / segments;
  double angle = startAngle;
  for (int i = 0; i < segments; i++) {
    ENRMArcSegment(path, cx, cy, rx, ry, phi, angle, segDelta);
    angle += segDelta;
  }
}

CGPathRef ENRMCreateCGPathFromSVGPath(NSString *pathData)
{
  if (pathData.length == 0) {
    return NULL;
  }

  NSData *utf8 = [pathData dataUsingEncoding:NSUTF8StringEncoding];
  ENRMScanner scanner = {.chars = (const char *)utf8.bytes, .length = utf8.length, .index = 0};
  ENRMScanner *s = &scanner;

  CGMutablePathRef path = CGPathCreateMutable();
  double cx = 0, cy = 0;         // current point
  double sx = 0, sy = 0;         // subpath start
  double lastCx = 0, lastCy = 0; // last cubic control point (for S/s)
  double lastQx = 0, lastQy = 0; // last quadratic control point (for T/t)
  char lastCommand = 0;
  char command = 0;

  while (s->index < s->length) {
    ENRMScanSkipSeparators(s);
    if (s->index >= s->length) {
      break;
    }

    char c = s->chars[s->index];
    if (ENRMScanIsCommand(c)) {
      command = c;
      s->index++;
    } else if (command == 0) {
      break; // malformed: data before any command
    } else if (command == 'M') {
      command = 'L'; // implicit lineto for repeated M coordinate pairs
    } else if (command == 'm') {
      command = 'l';
    }

    switch (command) {
      case 'M':
      case 'm': {
        double nx, ny;
        if (!ENRMScanNumber(s, &nx) || !ENRMScanNumber(s, &ny)) {
          goto done;
        }
        if (command == 'm') {
          nx += cx;
          ny += cy;
        }
        cx = nx;
        cy = ny;
        sx = cx;
        sy = cy;
        CGPathMoveToPoint(path, NULL, (CGFloat)cx, (CGFloat)cy);
        break;
      }
      case 'L':
      case 'l': {
        double nx, ny;
        if (!ENRMScanNumber(s, &nx) || !ENRMScanNumber(s, &ny)) {
          goto done;
        }
        if (command == 'l') {
          nx += cx;
          ny += cy;
        }
        cx = nx;
        cy = ny;
        CGPathAddLineToPoint(path, NULL, (CGFloat)cx, (CGFloat)cy);
        break;
      }
      case 'H':
      case 'h': {
        double nx;
        if (!ENRMScanNumber(s, &nx)) {
          goto done;
        }
        cx = command == 'h' ? cx + nx : nx;
        CGPathAddLineToPoint(path, NULL, (CGFloat)cx, (CGFloat)cy);
        break;
      }
      case 'V':
      case 'v': {
        double ny;
        if (!ENRMScanNumber(s, &ny)) {
          goto done;
        }
        cy = command == 'v' ? cy + ny : ny;
        CGPathAddLineToPoint(path, NULL, (CGFloat)cx, (CGFloat)cy);
        break;
      }
      case 'C':
      case 'c': {
        double c1x, c1y, c2x, c2y, nx, ny;
        if (!ENRMScanNumber(s, &c1x) || !ENRMScanNumber(s, &c1y) || !ENRMScanNumber(s, &c2x) ||
            !ENRMScanNumber(s, &c2y) || !ENRMScanNumber(s, &nx) || !ENRMScanNumber(s, &ny)) {
          goto done;
        }
        if (command == 'c') {
          c1x += cx;
          c1y += cy;
          c2x += cx;
          c2y += cy;
          nx += cx;
          ny += cy;
        }
        CGPathAddCurveToPoint(path, NULL, (CGFloat)c1x, (CGFloat)c1y, (CGFloat)c2x, (CGFloat)c2y, (CGFloat)nx,
                              (CGFloat)ny);
        lastCx = c2x;
        lastCy = c2y;
        cx = nx;
        cy = ny;
        break;
      }
      case 'S':
      case 's': {
        double c2x, c2y, nx, ny;
        if (!ENRMScanNumber(s, &c2x) || !ENRMScanNumber(s, &c2y) || !ENRMScanNumber(s, &nx) ||
            !ENRMScanNumber(s, &ny)) {
          goto done;
        }
        if (command == 's') {
          c2x += cx;
          c2y += cy;
          nx += cx;
          ny += cy;
        }
        double c1x = cx, c1y = cy;
        if (lastCommand == 'C' || lastCommand == 'c' || lastCommand == 'S' || lastCommand == 's') {
          c1x = 2 * cx - lastCx;
          c1y = 2 * cy - lastCy;
        }
        CGPathAddCurveToPoint(path, NULL, (CGFloat)c1x, (CGFloat)c1y, (CGFloat)c2x, (CGFloat)c2y, (CGFloat)nx,
                              (CGFloat)ny);
        lastCx = c2x;
        lastCy = c2y;
        cx = nx;
        cy = ny;
        break;
      }
      case 'Q':
      case 'q': {
        double c1x, c1y, nx, ny;
        if (!ENRMScanNumber(s, &c1x) || !ENRMScanNumber(s, &c1y) || !ENRMScanNumber(s, &nx) ||
            !ENRMScanNumber(s, &ny)) {
          goto done;
        }
        if (command == 'q') {
          c1x += cx;
          c1y += cy;
          nx += cx;
          ny += cy;
        }
        CGPathAddQuadCurveToPoint(path, NULL, (CGFloat)c1x, (CGFloat)c1y, (CGFloat)nx, (CGFloat)ny);
        lastQx = c1x;
        lastQy = c1y;
        cx = nx;
        cy = ny;
        break;
      }
      case 'T':
      case 't': {
        double nx, ny;
        if (!ENRMScanNumber(s, &nx) || !ENRMScanNumber(s, &ny)) {
          goto done;
        }
        if (command == 't') {
          nx += cx;
          ny += cy;
        }
        double c1x = cx, c1y = cy;
        if (lastCommand == 'Q' || lastCommand == 'q' || lastCommand == 'T' || lastCommand == 't') {
          c1x = 2 * cx - lastQx;
          c1y = 2 * cy - lastQy;
        }
        CGPathAddQuadCurveToPoint(path, NULL, (CGFloat)c1x, (CGFloat)c1y, (CGFloat)nx, (CGFloat)ny);
        lastQx = c1x;
        lastQy = c1y;
        cx = nx;
        cy = ny;
        break;
      }
      case 'A':
      case 'a': {
        double rx, ry, rot, laf, sf, nx, ny;
        if (!ENRMScanNumber(s, &rx) || !ENRMScanNumber(s, &ry) || !ENRMScanNumber(s, &rot) ||
            !ENRMScanNumber(s, &laf) || !ENRMScanNumber(s, &sf) || !ENRMScanNumber(s, &nx) || !ENRMScanNumber(s, &ny)) {
          goto done;
        }
        if (command == 'a') {
          nx += cx;
          ny += cy;
        }
        ENRMAppendArc(path, cx, cy, rx, ry, rot, laf != 0.0, sf != 0.0, nx, ny);
        cx = nx;
        cy = ny;
        break;
      }
      case 'Z':
      case 'z': {
        CGPathCloseSubpath(path);
        cx = sx;
        cy = sy;
        break;
      }
      default:
        goto done;
    }

    lastCommand = command;
  }

done:
  return path;
}
