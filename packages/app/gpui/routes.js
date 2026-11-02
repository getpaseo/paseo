// Use the existing route tree. Expo's transformer normally supplies this root
// through a Babel caller field; the RN desktop transformer does not.
export const ctx = require.context(
  "../src/app",
  true,
  /^(?:\.\/)(?!(?:(?:(?:.*\+api)|(?:\+(html|native-intent))))\.[tj]sx?$).*\.[tj]sx?$/,
);
