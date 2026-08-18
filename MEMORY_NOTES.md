# Memory notes — WebKit footprint fix

> **2026-08-18 — the 1.2 GB came back, and the diagnosis below was incomplete.**
> The idle-warmth work in this document is real but it was not the root cause;
> it only slowed the growth (~2 days to 1.18 GB → ~6.5 days to 1.25 GB). The
> actual leak was the sleep-aura Zzz spawner, and the 8-hour soak that "proved"
> the fix passed only because it ran in the one state where the leak cannot
> fire. **Read [Round 2](#round-2--the-actual-leak-2026-08-18) first**; treat
> the 58 MB plateau claim below as superseded.

## TL;DR

The idle WebContent process was sitting at **~1.18 GB** physical footprint. Root
cause was not a single leak but a set of **forever-running things that kept the
WebContent process from ever going idle**, so WebKit's allocator never scavenged
and JSC never ran a full GC. Fixing that (pause everything when hidden + stop
re-reading the whole plan file on every poll) brought idle footprint to **~16 MB**.

| Metric (WebContent, idle) | Before | After |
|---|---|---|
| phys_footprint (fresh) | ~15 MB | ~15 MB |
| **phys_footprint (idle, aged)** | **~1180 MB** (peak 1219, after ~2 days) | ~~**~58 MB, plateaus**~~ — **wrong, see Round 2**: reached 1253 MB in 6.5 days |
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
- **8-hour release soak** (WebContent, idle, visible, no DevTools, sampled every
  10 min): footprint climbs in steps from 14 MB to a **~57–58 MB plateau and then
  holds flat** — 57 MB unchanged from 05:33 to 09:13 (≈3.7 h straight), only
  +1 MB over the final ~5 h. MALLOC_SMALL regions settle at **605** (vs **9623**
  on the aged buggy process). CPU ~0 throughout. This is the JS heap growing to
  its working set and then plateauing — not a leak. Well under the 250 MB ceiling
  and the 150 MB target.

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

---

# Round 2 — the actual leak (2026-08-18)

The pet ran 6 days 13 h on the "fixed" build and reached **1253 MB** (peak =
current, i.e. monotonic, never once falling back).

## TL;DR

**Every floating `z` permanently leaked ~17 KB.** 54,389 of them over 6.5 days
≈ the whole 1.25 GB. `spawnZ()` minted a div + a Web-Animations object per
tick and dropped both in `onfinish` — but a finished `Animation` that still has
an `onfinish` handler stays registered as a **GC root**, so nothing in the graph
it holds was ever collectable.

## Evidence

`heap` on the live process — one live object per leaked z, straight down:

```
 5685862  727747104  128.0  non-object                      ← keyframe RenderStyle storage
  336873   10779936   32.0  WebCore::LinearTimingFunction     (6 × 56,127)
  163169    7832112   48.0  Style::TranslateTransformFunction (3 × 54,389)
  163168    7832064   48.0  Style::RotateTransformFunction    (3 × 54,389)
   56127   57474048 1024.0  WebCore::BlendingKeyframe
   56127   25144896  448.0  WebCore::KeyframeEffect
   56127   17062608  304.0  WebCore::WebAnimation
   54385    4350800   80.0  WebCore::JSEventListener        ← the onfinish handlers
   54383    6090448  112.0  WebCore::Text                   ← the "z" glyph
   54359    6957952  128.0  WebCore::HTMLDivElement
   54087   34615680  640.0  NSCTFont                        ← one per random font size
```

`translate + rotate across 3 keyframes` is a fingerprint unique to `spawnZ`.
936 MB of live objects ÷ 54,389 z = **17.2 KB each**, and `heap`'s live total
matched the process footprint — so this was ~100 % of the 1.25 GB, not a
fragmentation artifact.

Three checks pinned the mechanism:

1. **They were out of the DOM.** The whole page had 14 `RenderBlockFlow` + 6
   `RenderText` + 254 `LegacyRenderSVGRect` (the pet sprite) — ~20 render
   objects total. 54 k divs with zero renderers ⇒ `z.remove()` did run and the
   animations did finish. This was *not* an unbounded DOM.
2. **A forced full GC freed nothing.** `notifyutil -p org.WebKit.lowMemory`
   (WebKit's memory-pressure handler: full JSC GC + cache purge) moved the
   footprint 1253 → 1244 MB and left every count intact. So these were not
   garbage awaiting a lazy GC — they were **reachable roots**.
3. **The rate matched.** 54,389 nodes / 6.57 days = one per 10.4 s average,
   against a 1.4 s spawner ⇒ ~13 % duty cycle, i.e. ~3 h/day of visible daytime
   napping. Consistent.

## Root cause

`element.animate()` returns an `Animation` registered with the document
timeline. Attaching `onfinish` gives it an event listener, and WebKit keeps such
an animation alive as an ActiveDOMObject root — playing out does not release it.
It then transitively retains its `KeyframeEffect`, the per-keyframe
`RenderStyle` (the 128-byte `non-object` bulk), and, through the closure, the
detached `<div>`, its text node, its inline style, and its font.

`spark()` had the identical `a.onfinish = () => s.remove()` shape (~200 KB
retained per click), and every one-shot `petBody.animate(...)` leaked its own
Animation the same way.

Amplifier: `font-size: ${9 + Math.random() * 5}px` gave each z a **unique
fractional size**, so WebKit's font cache grew one `NSCTFont` (640 B) plus
dictionaries per particle — 34 MB of the total on its own.

## Trigger conditions

The leak needed **visible × asleep × not deep-night**, all three:

- hidden ⇒ `suspendVisuals()` → `stopZzz()`, and
- 22:00–05:00 ⇒ the still moon replaces the drifting Zzz.

Rate while those hold: 1 z / 1.4 s × 17 KB ≈ **44 MB/hour**.

## Why the 8-hour soak passed

It ran 02:23 → 10:23 with the display asleep for much of it. `napCheck()`
returns early when `document.hidden`, so **the pet never fell asleep**, so the
Zzz aura never ran. The soak measured the one state in which the bug is
inert — and the flat stretch it reported (05:33–09:13) is exactly the window
where a napping pet would have been leaking hardest.

## The fix

The fx layer is now a **fixed pool built once** — 3 Zzz nodes, the moon, and 24
sparkles — driven by CSS keyframes:

- **Zzz**: one 4200 ms `zzz-drift` keyframe loop on three nodes staggered by
  `animation-delay` 0 / 1400 / 2800 ms, so a z still lifts off every 1.4 s.
  `startZzz`/`stopZzz` toggle a `.zzz-on` class, which adds/removes the
  animation outright (not `paused`, which would keep the compositing layer).
  Sizes are three fixed integers, so the font cache holds three entries.
  Caveat that bit once: the `animation:` shorthand resets `animation-delay`, so
  the per-node delays must come **after** it at equal specificity or all three
  z's take off in unison.
- **Sparkles**: a burst re-points pooled nodes via `--dx/--dy/--dur` custom
  properties and restarts the CSS animation. No allocation per particle.
- **One-shots** (`hop`, `pickup`, `exhale`, `puff`, `petRollback`, the yawn) go
  through `animateOnce()`, which nulls `onfinish` and calls `cancel()` when the
  animation ends, unregistering it from the timeline.
- `startZzz()` now bails when `document.hidden`. `applySleepAura()` runs from
  `enterSleep`/`enterAwake`, and a poll can reload an all-done plan behind the
  tray — without the guard the aura restarted itself after `suspendVisuals()`
  had torn it down, leaving a forever-animation on an invisible window.

Net: **a sleeping pet allocates nothing per tick.**

## Verifying it (this is the part the old soak got wrong)

`sandbox/harness.html` now ships `__fxSoak(seconds)`. It pins `document.hidden`
false, clicks the plan to all-done, asserts the pet is actually asleep **with
the aura on**, then samples `__kirbyTest.fxStats()`:

```js
await __boot({ content: "# t\n\n- [ ] a\n- [ ] b\n" });
await __fxSoak(30)   // → { leaked: false, children: [28,28], animations: [37,37] }
```

Measured against the old build for contrast, same probe:

| build | fx children over 16 s | live animations |
|---|---|---|
| before | 31 → 40 (monotonic) | 38 → 47 |
| after | 28 → 28 | 35 → 35 |

Keyframe fidelity was checked by driving `Animation.currentTime` directly
(a backgrounded tab does not advance animations, so sampling a running one is
useless): opacity 0 → 0.9 @570 ms → 0 @1900 ms, translate (0,0) →
(6,−10) → (16,−30), rotate −6° → 4° → 10° — identical to the WAAPI keyframes it
replaced. Behaviour sweep: night→moon, day→Zzz, hidden→aura off, visible→aura
back, rollback→awake, reduced-motion→0 animations, fx children pinned at 28
throughout. `npm test` 10/10, `cargo test` 4/4.

**When re-measuring the real app, the pet must be visibly asleep** (finish every
task, or leave it untouched past `IDLE_NAP_MS`, with the display on and the
clock outside 22:00–05:00). An idle-but-awake pet, or a sleeping pet behind a
dark display, proves nothing.
