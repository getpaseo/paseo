---
name: store-screenshots
description: Refresh the App Store and Google Play screenshots for phones and tablets. Use when the user says "store screenshots", "app store screenshots", "play store screenshots", "iPad screenshots", "recapture the screenshots", or wants the store panels changed.
user-invocable: true
---

# Store screenshots

Follow `assets/store-screenshots/README.md`. It owns the panels, the creative direction, the render command and the recapture steps. Change copy, crops and layout in `assets/store-screenshots/render.mjs`, not in the exports.

Working rules:

- Capture at native density: `--pixel-density 3` on the iPhone 16 Pro Max, `--pixel-density 2` on the iPad Pro 13-inch. The default is 1x, which is too soft for the store.
- Every headline wraps to two lines and every subline fits on one. The renderer enforces this; rewrite the copy rather than shrink the type.
- Use SF Pro. Never substitute another font.
- Open `output/preview.png` and a full-size panel from each store before you report a render. Show the user the preview.
- Do not upload screenshots to a store, a PR, or anywhere public, and do not commit, unless the user asks.
- Stage the demo host on its own port and pick a free Metro port. Do not restart the main daemons.
- When you learn something the next capture needs, fix the README rather than this skill.
