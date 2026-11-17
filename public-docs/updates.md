---
title: Updates
description: How Paseo releases work, the difference between stable and beta channels, and how to opt in to earlier updates.
nav: Updates
order: 5
category: Getting started
---

# Updates

Paseo ships updates through two channels: **Stable** and **Beta**.

Most releases go out on the stable channel. Betas are release candidates that let you test what's coming next before it rolls out to everyone.

## Version numbers

Paseo follows [Semantic Versioning](https://semver.org) with prerelease tags.

A stable release looks like this:

```
v0.1.90
```

A beta for the same release looks like this:

```
v0.1.90-beta.1
```

If a release needs more testing, we cut additional betas:

```
v0.1.92-beta.1
v0.1.92-beta.2
v0.1.92-beta.3
```

When the release is ready, the final stable tag is `v0.1.92` — not `v0.1.93`. The betas are checkpoints on the way to the same stable version.

## Stable channel

The stable channel is the default. Stable desktop releases roll out gradually over **36 hours** so that if something unexpected slips through, it doesn't hit everyone at once. Automatic update checks pick up the release as the rollout progresses; clicking **Check** in the app bypasses the rollout and installs immediately.

Stable releases are what most users should run.

## Beta channel

The beta channel gets every prerelease as soon as it's published, with no rollout delay. When a beta is promoted to stable, beta users receive that stable update immediately too.

Betas are the best way to get fixes and features early. If you hit a bug, report it — beta feedback is what makes stable releases reliable.

### How to join the beta channel

| Platform       | How to get betas                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| iOS and iPadOS | Join the [Paseo TestFlight beta](https://testflight.apple.com/join/Y5HpSQjJ).                                 |
| Android        | Download the APK from a prerelease on the [GitHub releases page](https://github.com/getpaseo/paseo/releases). |
| Desktop        | Open **Settings → About** and select **Beta** under **Release channel**.                                      |
| CLI            | Run `npm install -g @getpaseo/cli@beta`. Plain `npm install -g @getpaseo/cli` stays on stable.                |

The desktop app checks for beta updates from the moment you select **Beta**.

## App stores

Desktop releases and the CLI are usually available first. App Store and Play Store releases can lag behind because they go through review.

The App Store and Play Store listings carry stable builds only. On iOS, the [TestFlight beta](https://testflight.apple.com/join/Y5HpSQjJ) is the beta channel. Every beta is uploaded to it after Apple's beta review, and stable releases are uploaded to it as well, so TestFlight testers stay on the latest build. On Android there is no Play Store beta, so install beta APKs from GitHub.

## What to do if something breaks

Beta builds are expected to have rough edges. If a beta causes problems, you can switch back to the stable channel in **Settings → About → Release channel**. The next stable update will install normally.

If you need a fix that hasn't shipped to stable yet, stay on beta and report the issue. Most problems found in beta are fixed before the stable release.
