---
title: An uncommitted Capacitor WKWebView reload paints black on first activation
date: 2026-08-17
category: integration-issues
module: ios-webview-host
problem_type: integration_issue
component: ios_webview
symptoms:
  - "The product app reaches the foreground on a physical iPad and stays there, but the screen is fully black apart from the status bar"
  - "The native App process is alive; terminate-and-relaunch paints the Trail or picker correctly"
  - "The same build on a clean iPhone install paints first launch correctly"
  - "A second screenshot minutes later in the same foreground session is still black"
root_cause: wrong_api
applies_when:
  - "First activation after installing a product build over a previous bundle-id occupant"
  - "A Capacitor iOS host reports webViewWebContentProcessDidTerminate during the first navigation"
  - "A physical iPad first-launch screenshot is black while XCUIApplication is runningForeground"
resolution_type: code_fix
severity: high
related_components:
  - "capacitor_core"
  - "ios_webview"
  - "product_ui"
tags:
  - "ios"
  - "wkwebview"
  - "capacitor"
  - "first-paint"
  - "ipad"
  - "install-over"
  - "source-text-pin"
---

# An uncommitted Capacitor WKWebView reload paints black on first activation

## Problem

A parent's first launch of the product on the floor iPad 8 painted black. The
native process stayed alive. Terminate-and-relaunch painted the Trail with the
install-over learner residue intact. The same binary's first launch on a clean
iPhone SE 2 was fine. App Review uses iPads; a black first activation is a
Guideline 2.1 completeness hard stop.

## Symptoms

- `XCUIApplication.activate` after `devicectl device install app` (no uninstall)
  reached `runningForeground` with a fully black framebuffer except the status
  bar.
- `devicectl device info processes` showed `App.app/App` running throughout.
- A screenshot two minutes later, same session, was still black.
- `devicectl device process launch --terminate-existing` recovered immediately.

## What Didn't Work

**Reading the hang as the #180 SQLite soft-reload brick.** That recovery
(`checkConnectionsConsistency` before `createConnection`) repairs a JS world
that rebuilt while the native plugin still held the previous page's connection.
Install-over first activation is a new native process. The JS world never ran:
the loading shell never appeared. A database adapter cannot paint a document
that was never committed.

**Calling `webView.reload()` the way Capacitor 8.4.1 does.**
`WebViewDelegationHandler.webViewWebContentProcessDidTerminate` resets the
bridge and reloads. `reload()` is a no-op when the first navigation never
committed (`url == nil` or `about:blank`). The same handler sets
`isOpaque = false` on the initial load and restores it only in `didFinish` /
committed `didFail` — not on provisional failure and not on process death — so
the hang is a transparent web view over an unset window, which reads as black.

**Terminate-and-relaunch as the test path.** C5's tablet probes already
`terminate()` then `launch()`. That is the workaround the device already had.
A probe that relaunches cannot go red on this hang.

## The Fix

The product bridge owns first paint, not Capacitor's default handler:

1. Replace a `.zero` creation frame with `UIScreen.main.bounds`. Capacitor
   always constructs the web view at zero; growing from zero after an iPad
   scene attaches is a known WKWebView blank-screen path.
2. Restore `isOpaque = true` and a system background on the web view and the
   window as soon as `viewDidLoad` returns, so an unfinished first load cannot
   punch through to black.
3. Two seconds after first load, if the URL is still nil, empty or
   `about:blank`, call `loadWebView()` — re-issue the start URL. Do not call
   `reload()`.

The C5 probe `testProductFirstActivationPaintsContent` uses `activate()` only
and waits for Getting ready, Who is practising?, Set off or Add a learner.
`tests/ios-webview-first-paint-contract.test.mjs` goes red if recovery is
reverted to `reload()`, if opacity is left false, or if the probe gains
`terminate()`.

## Why This Works

The observed hang is process-local and first-session-only: disk state survived
and painted after a new web view existed. Re-issuing the start URL is the
in-process form of that relaunch, aimed at the one WKWebView API that is a
no-op in the uncommitted state. Opacity restoration makes a future hang visible
as a blank system background rather than a black hole, and the activate-only
probe is the path App Review and the floor-device screenshot UITest actually
take.

## Prevention

- Native first-paint probes must `activate()` the installed bundle without
  `terminate()`. Relaunch is a different code path.
- Never treat Capacitor's `webView.reload()` as a first-load recovery. If the
  start URL has not committed, call `loadWebView()`.
- A black screenshot attached to a UITest that only waited for
  `runningForeground` is not evidence the app painted.
