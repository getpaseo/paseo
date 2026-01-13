// Polyfill crypto.randomUUID for React Native before any other imports
import { polyfillCrypto } from "./src/polyfills/crypto";
polyfillCrypto();

// Configure Unistyles before Expo Router pulls in any components using StyleSheet.
import "./src/styles/unistyles";
import "expo-router/entry";
