# Memory notes — WebKit footprint fix

## TL;DR

The idle WebContent process was sitting at **~1.18 GB** physical footprint. Root
cause was not a single leak but a set of **forever-running things that kept the
WebContent process from ever going idle**, so WebKit's allocator never scavenged
and JSC never ran a full GC. Fixing that (pause everything when hidden + stop
re-reading the whole plan file on every poll) brought idle footprint to **~16 MB**.

| Metric (WebContent, idle) | Before | After |
|---|---|---|
| phys_footprint (fresh) | ~15 MB | ~15 MB |
| **phys_footprint (idle, aged)** | **~1180 MB** (peak 1219, after ~2 days) | **~20 MB, flat** (15-min soak; see below) |
| WebKit malloc (dirty) | 876 MB | ~9 MB |
| MALLOC_SMALL | 293 MB across **9623 regions** | ~1–2 MB across **~340 regions** |
| Reclaimable | ~0 (all dirty/live) | small |
| Main Rust process | ~40 MB | ~40 MB (unchanged) |
| GPU / Networking helpers | ~18 MB / ~6 MB | unchanged |

Well under the 250 MB hard ceiling and the 150 MB preferred target.

## Root cause

`footprint` (what Activity Monitor shows as "Memory") counts dirty + compressed
pages; it stays high even when `ps` RSS looks small, because WebKit's allocator
(libpas/bmalloc) frees with `MADV_FREE` and only truly scavenges under memory
pressure or when the process idles. On the aged baseline, **`Reclaimable` was ~0**
— the whole 1.18 GB was dirty pages WebKit still considered live after two days.

Three things kept the process permanently "warm" so it never idled or scavenged:

1. **An infinite Web-Animations breathing loop** on the sprite
   (`petBody.animate(..., { iterations: Infinity })`). On a transparent,
   always-on-top WKWebView this pins a compositing layer and keeps the compositor
   producing frames forever (main-thread CPU reads ~0 because WAAPI transforms run
   off the main thread), so the process never reaches the idle state that triggers
   memory reduction.
2. **Forever timers** — the recursive `blinkLoop()` `setTimeout` and the Zzz
   spawner — plus these all kept running **even when the window was hidden** via
   the tray (there was no `visibilitychange` handling). Hidden ≠ suspended.
3. **A full-file read every 2.5 s.** `poll()` called `read_text` and materialized
   the entire plan file as a JS string every poll, then compared it to a retained
   `lastContent` string. That is ~24 whole-file allocations/minute fed into
   WebKit malloc, matching the **9623 MALLOC_SMALL regions** seen on the aged
   process (small allocations that accumulated and were never returned).

## What changed

Surgical edits, no new deps, public behavior preserved.

- **`ui/main.ts`**
  - Visibility gating: on `visibilitychange → hidden`, `suspendVisuals()` cancels
    the breathing animation, stops the blink loop, and stops Zzz. On return,
    `resumeVisuals()` restores them for the current mood/time-of-day.
  - `blinkLoop()` now keeps a timer handle and stops rescheduling while hidden
    (`stopBlink()`); `refreshTimeOfDay()` no-ops while hidden so it can't respawn
    the Zzz aura.
  - Poll cadence is self-rescheduling: **2.5 s visible, 30 s hidden**
    (`HIDDEN_POLL_MS`). Coming back to visible does one immediate catch-up poll.
  - **Cheap poll:** new `lastStat` signature (`mtime:len`). `poll()` calls the new
    `plan_stat` command first and only does a full `read_text` when the signature
    changes. Idle polls now allocate no whole-file string. `save()` refreshes the
    stat after its own write so it doesn't trigger a re-read.
  - Plan-path resolution is throttled to every 6th poll (`RESOLVE_EVERY`) instead
    of every poll — one fewer IPC + string per idle tick. A tray/config plan-file
    switch is still noticed within ~15 s (and immediately on window resume).
- **`src-tauri/src/lib.rs`**
  - New `plan_stat(path) -> (mtime_ms, len)` command (metadata only, no file read),
    registered in the invoke handler. Rust test `plan_stat_reports_len_and_tracks_changes`.
- **`sandbox/harness.html`**
  - Mock `plan_stat` (content-hash + length) so the browser harness exercises the
    new poll path.

## Verification

Functional proof via the browser harness (`sandbox/harness.html`), release
tests, and a footprint soak on the release bundle.

- **Animation gating** (`document.getAnimations()`): visible → 1 running infinite
  animation; hidden → **0** running (still 0 after a full blink cycle); resumed → 1.
- **Stat-gated poll** (counting `invoke` calls): idle poll cycles →
  **N `plan_stat`, 0 `read_text`**; an external edit → exactly **1 `read_text`**,
  progress updated 0/3 → 1/3.
- **Throttled resolve**: over ~6 idle polls → **1 `plan_path`** (not 6) and still
  **0 `read_text`**; a simulated tray plan-file switch is still picked up.
- `npm test` → 10/10 pass. `cargo test` → 4/4 pass.
- Release soak (WebContent, idle, no DevTools, 15 min @ 90 s): **16 → 20 MB then
  flat at 20 MB**, MALLOC_SMALL regions flat at **340** (vs 9623 aged), CPU ~0.
  (See "Re-measure" to reproduce / extend to an overnight run.)

Regression check — all interactions still work: complete, rollback, collapse/
expand board, idle nap, wake, done-celebrate, file poll pick-up, autosave,
reduced-motion.

## Re-measure (exact commands)

```bash
# PIDs
main=$(pgrep -f 'Typewriter Plan.app/Contents/MacOS/typewriter-plan')
wc=$(pgrep -f 'com.apple.WebKit.WebContent')

# Footprint breakdown
footprint -p "$wc" | head -20
ps -p "$wc" -o pid,rss,vsz,pcpu,pmem
```

The original bug took ~2 days to reach 1.18 GB, so the definitive proof is a long
idle soak. A quick loop:

```bash
wc=$(pgrep -f 'com.apple.WebKit.WebContent')
while true; do
  echo "[$(date +%H:%M:%S)] $(footprint -p $wc | grep phys_footprint:)"
  sleep 300
done
```

Measure the **release** bundle (`npm run build`), not `tauri dev`, and with
DevTools closed.

## Follow-ups / notes

- **Transparent WKWebView floor** appears to be ~15–20 MB here; that's the
  practical minimum and is fine.
- The global `mousemove → bumpInteraction` listener was left as-is: it only fires
  while the window is visible (user present) and does trivial work, so it is not a
  memory factor. Left untouched to keep behavior identical.
- If future growth ever reappears, first re-check that `visibilitychange` fires on
  the tray hide path in the shipping OS build; the fix depends on it.
