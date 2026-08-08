# Typewriter Plan 🎀

A tiny **pixel-Kirby desktop pet** that holds your study plan. The little pink
blob floats in a corner of your screen with a small card showing only **three**
lines of your plan at a time:

```
刚完成   ← the one you just finished
正在做   ← what you're on now
下一个   ← what's up next
```

Click the **正在做** row to complete it → the list rolls up one line (like a
typewriter carriage). Click the **刚完成** row to un-check it → the list rolls
back one line.

There is **no import / paste / edit UI at all**. To load or change a plan, an
LLM (or you) just writes Markdown into one file:

```
<VAULT_PATH>/Study Plans/current.md
```

The pet reads that file, and **auto-refreshes within ~2.5s whenever the file
changes** — so telling Claude "put this plan in" and having it write the file is
the whole import flow. Your click-offs are written back to the same file
(atomic writes), so progress round-trips both ways.

The window is **transparent, frameless, always-on-top, and draggable** — a real
desktop pet, not a boxy app window.

Built deliberately small: **Tauri v2 + vanilla TypeScript + one HTML file + one
CSS file**. No React/Vue, no bundler, no state library.

```
typewriter-plan/
├── ui/                 # the entire frontend
│   ├── index.html
│   ├── styles.css
│   └── main.ts         # parse / roll / save + the pixel-pet sprite (tsc → main.js)
├── src-tauri/
│   ├── src/lib.rs      # two commands: read_text + atomic write_atomic
│   ├── src/main.rs
│   ├── tauri.conf.json # transparent / frameless / always-on-top window
│   └── capabilities/default.json
├── scripts/gen_icon.py # generates the app icon (no external deps)
└── package.json
```

## Change your Obsidian vault path

Open [`ui/main.ts`](ui/main.ts) — the path is right at the top, clearly marked:

```ts
const VAULT_PATH = "/Users/yyukin0/Documents/obsidian"; // <-- your vault root
const SUBDIR = "Study Plans";                            // <-- subfolder for plans
```

Change `VAULT_PATH` to your vault, save, and re-run. Files are written to
`<VAULT_PATH>/<SUBDIR>/<slug>.md`.

## Run in development

```bash
npm install
npm run tauri dev
```

The first `dev` run compiles the Rust dependencies, so it takes a couple of
minutes; later runs are fast.

> `beforeDevCommand` runs `npm run build:ui` (tsc) automatically before the app
> starts. If you edit `main.ts` while the app is running, re-run `dev` (or run
> `npm run watch:ui` in another terminal) to recompile.

## Build a distributable `.app`

```bash
npm run tauri build
```

The bundle is written to
`src-tauri/target/release/bundle/macos/Typewriter Plan.app`. Copy it to
`/Applications` (drag it in Finder) to keep it around. A `.dmg` is also produced
under `bundle/dmg/`.

> The app is unsigned. On first launch macOS may block it — right-click the
> `.app` → **Open**, or allow it in **System Settings → Privacy & Security**.

## How to use

- **Load / change a plan** — write Markdown to `Study Plans/current.md` (ask
  Claude to do it). The pet picks it up automatically. Supported lines:
  - `# / ## / ###` → group headings (kept in the file, not shown on the pet card)
  - `- `, `* `, `1.`, `2)` → checklist items
  - `- [x]` / `- [ ]` → items with their checked state preserved
  - blank lines / other text → kept as-is in the file
- **Use the prompt template** — copy the prompt in [`PROMPT.md`](PROMPT.md) into
  Claude's project instructions or memory. After that, just say things like:
  - "帮我列一份明天 Kirby 计划，5 道链表 Medium"
  - "Kirby，把今天的计划改成 3 道树 + 2 道图"
  - "追加 3 道 DP"

  Claude will know the exact file path and format, and will preserve your existing progress.
- **Progress is linear** — the card always shows just the 3 lines around where
  you are. Complete the middle one to roll forward; un-check the top one to roll
  back. The `X / Y` counter in the corner tracks completed / total.
- **Move it** — drag the pet's body or the card's title bar. It stays on top of
  other windows.
- **Close it** — hover the card and click the **×** (top-right), or ⌘Q.
- **Auto-save** — every roll writes progress back to `current.md` (debounced
  ~0.8s); `已保存 HH:MM:SS` shows on the card.
- **Reopen** — it just reads `current.md` again, so your plan and progress are
  always there.

## Written file format

```markdown
---
title: Rust 冲刺
created: 2026-08-08
updated: 2026-08-08 01:56
progress: 3/5
---

# Rust 冲刺

## 第一周
- [x] 装环境
- [x] 读第 1 章
- [x] 写第一个程序
- [ ] 做练习题
## 第二周
- [ ] 项目实战
```

Writes are atomic (temp file + `fsync` + `rename`), so Obsidian never sees a
half-written file even if it's open.

> Note: progress is **linear** — checkboxes in the file always reflect "the first
> N tasks are done." If you hand-edit the file in Obsidian with a non-contiguous
> mix of `[x]`/`[ ]`, the pet treats the first unchecked task as your current
> position the next time it loads.
