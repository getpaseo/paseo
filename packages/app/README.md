# Paseo Web App

This workspace contains the Expo-based web client used by Paseo and the shared UI consumed by the macOS desktop app.

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the web app

   ```bash
   npm run web
   ```

3. Build the production bundle

   ```bash
   npm run build:web
   ```

The app uses Expo Router and exports the production build to `dist/`.

## Dictation debugging

Set `EXPO_PUBLIC_ENABLE_AUDIO_DEBUG=1` before running `npx expo start` to render the in-app audio debug card. Pair it with the server-side `STT_DEBUG_AUDIO_DIR` flag so every dictation includes a copyable path to the saved raw audio file.
