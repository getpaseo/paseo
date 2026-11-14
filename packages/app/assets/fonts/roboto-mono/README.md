# Roboto Mono

Unmodified static fonts from [googlefonts/RobotoMono](https://github.com/googlefonts/RobotoMono/tree/895ec691990d041dd727c7b5afa3ce56525d98e6/fonts/ttf), commit `895ec691990d041dd727c7b5afa3ce56525d98e6`.

Licensed under the SIL Open Font License 1.1; see `OFL.txt`. The Android build includes the license alongside the font assets.

Android maps React Native's `monospace` family and its four style variants to these bundled files. System font aliases can resolve to proportional fonts on vendor firmware, even when `/system/etc/fonts.xml` names an actual monospace font. Loading the files directly preserves equal glyph advances without depending on those aliases.
