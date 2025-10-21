# EAS Update Setup Guide

## Current Status

✅ **Completed:**
- Installed `eas-cli` as dev dependency
- Created `eas.json` with update channels (production, preview, development)
- Configured `app.json` with runtime version policy

⏳ **Manual Steps Required:**

### 1. Initialize EAS Project

Run the following command and follow the prompts:

```bash
npx eas init
```

This will:
- Prompt you to log in to your Expo account (create one if needed at expo.dev)
- Create a new project in your Expo account
- Add a `projectId` to your `app.json` under `expo.extra.eas.projectId`

### 2. Update the Updates URL

After running `eas init`, you'll receive a project ID. Update the `updates.url` in `app.json`:

```json
"updates": {
  "url": "https://u.expo.dev/YOUR_PROJECT_ID_HERE"
}
```

Replace `YOUR_PROJECT_ID` with the actual project ID from the previous step.

### 3. Build a New Development Build

Since you're using a custom development client (`expo-dev-client`), you need to create a new build with EAS Update configured:

```bash
# For Android
npx eas build --profile development --platform android

# For iOS (requires Apple Developer account)
npx eas build --profile development --platform ios
```

Install this new build on your device. Your existing development build won't receive updates.

## Publishing Updates

Once setup is complete, publish updates on the go:

### Production Update

```bash
npx eas update --branch production --message "Fix critical bug"
```

Users on the production channel will receive this update.

### Preview Update (for testing)

```bash
npx eas update --branch preview --message "Test new feature"
```

### Development Update

```bash
npx eas update --branch development --message "WIP changes"
```

## Update Channels Explained

- **production**: For released apps in app stores
- **preview**: For internal testing before production
- **development**: For active development testing

Configure which channel your app uses in `eas.json` or at build time.

## Runtime Version Policy

We're using `"policy": "appVersion"` which means:
- Updates only work within the same app version (1.0.0)
- If you change native code or dependencies, increment the version in `app.json`
- Users need a new build for native changes, but JS/React changes update via EAS

## Quick Reference

```bash
# Check update status
npx eas update:list --branch production

# Roll back to previous update
npx eas update:rollback --branch production

# View update details
npx eas update:view [update-id]
```

## Troubleshooting

**Update not appearing?**
- Ensure device is on the same channel as the update
- Force close and reopen the app
- Check the update was published: `npx eas update:list`

**"Runtime version mismatch" error?**
- Your app version doesn't match the update
- Rebuild the app with `eas build`

## Next Steps

1. Run `npx eas init` now
2. Update the `updates.url` in app.json with your project ID
3. Create a new development build with `npx eas build --profile development --platform android`
4. Install the new build on your device
5. Test publishing an update!
