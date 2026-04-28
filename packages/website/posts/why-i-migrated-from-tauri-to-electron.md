---
title: "Why I migrated from Tauri to Electron"
description: "Why I migrated from Tauri to Electron after rendering, WebKitGTK, notifications, and bundling a Node daemon made the pragmatic choice obvious."
date: "2026-03-29"
draft: "true"
---

I picked Tauri because it felt like the smarter choice.

Smaller runtime, lighter footprint, better story on paper. Electron felt brute-force by comparison. I remember having that feeling of "yeah, I'm not going to ship a whole browser just to build a desktop app."

Then I had to ship a real app.

Not a toy wrapper. A real cross-platform app with stable rendering requirements, a bundled Node daemon, and Linux support.

That's when my opinion started changing.

The first big crack was rendering stability. When you're building something you actually want people to use daily, that matters a lot more than the abstract elegance of the stack. I started caring less about theoretical efficiency and more about whether the UI behaved consistently across machines.

Then came the daemon side.

My app bundles a Node daemon. I spent a long time making that work inside Tauri. And to be fair, I did get it working. But at some point I had this pretty uncomfortable realization:

I was basically reinventing Electron.

I had picked Tauri partly to avoid bundling that whole world, and then product reality pushed me into rebuilding pieces of it anyway. What had started as architectural elegance was turning into self-inflicted complexity.

Then WebKitGTK really pushed it over the edge.

If you care about Linux, WebKitGTK is not some small implementation detail you can ignore. It becomes part of your product. Its bugs become your bugs. Its rendering behavior becomes your rendering behavior.

The WebKitGTK version Tauri picked up by default was old. Wayland did not work at all. After forcing a specific newer version of WebKitGTK and getting things to actually run, the rendering was all over the place. Worse than Safari, which already had its own set of platform-specific bugs I was chasing.

So I had Safari bugs on macOS, a broken or outdated WebKit on Linux, and Wayland not working. Suddenly the "lean" choice did not feel lean anymore.

I even got to the point where I was thinking: if I keep going down this road, I'm going to end up embedding my own renderer anyway.

That was the moment where the whole thing collapsed for me.

Because what exactly was I optimizing for anymore?

But the thing that probably burned me the most was notifications.

In my app, notifications are not a nice-to-have. Users need to click a notification and get taken to the right context. Pretty basic stuff.

Tauri could not handle notification click actions on desktop. You could show a notification, but you could not attach a callback to route the user somewhere when they clicked it. They did implement this for mobile, which honestly made me start to wonder where their focus actually was.

I ended up building platform-specific hacks to get click handling working across macOS and Linux. At that point the benefits of using Tauri were mostly gone. I was writing the glue code myself anyway.

In Electron, this was attaching a callback. That's it.

Electron started looking different after that.

Less "bloated default" and more "boring, stable, pragmatic runtime with fewer platform-specific surprises."

I changed my mind about it.

I still think Tauri is appealing. I get why people choose it. I chose it for the same reasons. And if your app is simple enough, or your platform constraints are different, maybe it's still the right call.

But for me, once the app got real, Electron became the more honest choice.

The lesson I took from this is pretty simple:

Sometimes the "smart" technical choice is only smart in the phase where your product is still hypothetical.

Once you have real requirements, real users, rendering issues, packaging issues, and platform-specific weirdness, the less elegant tool can end up being the more pragmatic one.

If you've gone the other direction, I'd be curious what your app looked like and where Tauri held up better.
