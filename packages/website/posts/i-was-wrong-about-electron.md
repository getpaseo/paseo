---
title: "I was wrong about Electron"
description: "Why I migrated Paseo from Tauri to Electron after the small-binary story stopped mattering more than rendering, notifications, and bundling a Node daemon."
date: "2026-05-28"
draft: "true"
---

When I started building Paseo, I picked Tauri.

The reasoning felt obvious at the time. I was building a desktop app with a web UI, and I cared about shipping something that did not feel bloated. Like a lot of developers, I had also internalized the idea that Electron was the bad option.

Tauri had all the right stuff: Rust, small binaries, native webviews, lower memory usage. It felt like the better choice.

I also kept seeing "Built with Tauri" on product landing pages, and I think that influenced me more than I realized. It made Tauri feel like what the cool kids were using.

I thought I knew better than all those other Electron apps. At first, it felt like I was right. On macOS, the app was small, the UI worked well, and the bundle size made me feel good about myself.

Getting the app working on Windows was not a problem. Tauri uses WebView2 there, which is Chromium-based, so the app behaved close enough to what I expected. There were platform quirks to deal with, but nothing specific to Tauri.

Linux is where things started getting complicated.

Tauri does not bundle one browser engine across platforms. That is the point. On Linux, it relies on WebKitGTK, which sounds elegant until you are debugging rendering behavior across distros, GPU setups, and Wayland/X11 differences.

For Paseo, this turned into a lot of product work I did not want to be doing. The WebKitGTK bindings Tauri was using were too old. Wayland had problems. And once I got the app running, it just looked different. It was not just small stuff like font weights or aliasing, some screens had real layout differences.

I could maybe have lived with all of this, but then I started implementing notifications.

For Paseo, notifications are not a nice to have. If an agent finishes, fails, or needs attention, I want the user to click the notification and land in the right place.

Tauri's notification plugin can show notifications, but [desktop click handling](https://github.com/tauri-apps/plugins-workspace/issues/2150) was not there in the way I needed. There's something called the Actions API that allows you to attach callbacks to notifications, but the docs mark it as mobile-only, which was strange.

This made me notice that Tauri was expanding into mobile apps, it was hard not to feel some doubt. I was still fighting basic desktop product issues while the framework was moving into something else entirely.

I tried a bunch of Rust crates, but none of them worked the way I wanted, so I ended up having to write the notification handling per platform. It was not straightforward, and now I had to maintain it.

There was also the daemon. This part is not really Tauri's fault, but it pushed me further toward Electron.

Paseo has a Node.js daemon, and I wanted a one-click experience. Download the app, open it, and go. I did not want to tell users "go run this command first" or teach them what a "daemon" was.

Tauri supports sidecars, so I got the daemon bundled and it worked. But it became its own project: different binaries for different platforms and target triples, packaging details, permissions, process spawning, paths, upgrades.

At some point I had the realization that I was building Electron with extra steps.

So I decided to try Electron. The migration was a bit of a pain, but I got things working surprisingly fast, and after a week of solid work Paseo actually felt lighter and simpler. The UI looked the same across platforms. Notifications behaved the way I needed. The daemon was simpler since it had Node pre-bundled.

Overall, I have been really happy with Electron since. It mostly gets out of my way. And when there are performance problems, they tend to come from my application code rather than Electron itself. I guess that is also why Electron gets a bad reputation, it is really easy to make a bloated Electron app.

My conclusion here is not that Tauri is bad. It was just the wrong choice for Paseo, and I made that choice more by vibes than by looking at the tradeoffs objectively.
