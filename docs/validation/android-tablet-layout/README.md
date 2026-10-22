# Android tablet layout QA

These screenshots are reference evidence from the Enhanced 0.12.2 Android APK (Expo 54 / React Native 0.81), tested on an API 35 ARM64 emulator at 1200×1920 and 320dpi. The conversation is synthetic and the host is offline. They verify sidebar shell behavior, not live Explorer data.

The upstream patch uses Expo 57 / React Native 0.86 and adapts the right dock to the current public Explorer sidebar API. This branch passes the app typecheck, targeted lint/format checks, and 170 tests across layout defaults, orientation, gesture intent, settings persistence, and translations. A native build and device/visual QA of this exact upstream branch are still pending; the reference screenshots do not replace that validation.

## Observed sequence in the delivered APK

1. Select Desktop for portrait; tap the left menu button, then the Explorer button. Both sidebars stay open. [Both open](v122-portrait-both-buttons.png).
2. Swipe right in the transcript. The right sidebar closes and the left stays open. [Right closed](v122-portrait-gesture-closes-right.png).
3. Swipe left in the transcript. The left sidebar closes without opening the right. [Both closed](v122-portrait-gesture-closes-left.png).
4. Restore landscape Desktop and portrait Phone independently in Appearance. [Settings](v122-default-layouts.png).
5. Rotate to portrait: full-screen compact navigation and numeric tab switcher return. [Portrait](v122-final-portrait.png).
6. Rotate to landscape: expanded tab row returns. The unsent draft survives both rotations. [Landscape](v122-final-landscape.png).

The shared intent tests also cover the next swipe opening the opposite sidebar, both opening directions, short/vertical/diagonal drags, and deliberate flick thresholds. The gesture surface leaves long-press text selection and vertical scrolling unclaimed; exact upstream native interaction remains part of the pending device QA.
