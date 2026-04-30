---
title: Updates
description: How to update Paseo daemon and apps across web, desktop, and mobile.
nav: Updates
order: 2
---

# Updates

Keep your daemon and apps current to get the latest fixes and features.

## Version compatibility

For now, daemon and app versions should be kept in lockstep. If your daemon is version X, make sure your clients are also version X.

## Update the daemon

Install the latest CLI/daemon package globally:

```bash
npm install -g @getpaseo/cli@latest
```

Then restart the daemon:

```bash
paseo daemon restart
```

## Web app

[app.paseo.sh](https://app.paseo.sh) is always up to date. No manual update needed.

## Desktop app

Download the latest desktop build from the GitHub releases page and install it over your current version.

[Paseo releases](https://github.com/getpaseo/paseo/releases)

## Mobile apps

Mobile apps are available on the App Store and Play Store. Update through your respective store. Store versions may lag behind the latest release due to review processes.
