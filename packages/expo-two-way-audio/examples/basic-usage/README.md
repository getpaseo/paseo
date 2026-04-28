# Expo Two-Way-Audio Using Flow API

This example showcases the basic functions of the expo-two-way-audio module:

- Capture input raw pcm data
- Play raw pcm data (from a hardcoded base64 string)
- Display volume level for both input and output
- In iOS: show/set microphone mode while recording.

## Requirements

- Node.js
- Expo CLI
- [iOS](https://docs.expo.dev/workflow/ios-simulator/) and/or [Android](https://docs.expo.dev/workflow/android-studio-emulator/) dev environment setup.

## Run the app

In the `examples/basic-usage` directory:

1. Install dependencies:
    ```sh
    npm install
    ```

2. Run the app:
    ```sh
    # Run iOS
    npm run ios

    # Run Android
    npm run android
    ```

## Notes

Some audio features of expo-two-way-audio like Acoustic Echo Cancelling, noise reduction or microphone modes (iOS) don't work on simulator. Run the example on a real device to test these features.

```bash
# iOS
npx expo run:ios --device --configuration Release

# Android
npx expo run:android --device --variant release
```
