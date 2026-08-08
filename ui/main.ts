// ============================================================================
// Typewriter Plan — a pixel-Kirby desktop pet holding your study plan.
//
// There is NO import/paste UI. To load a plan, an LLM (or you) simply writes
// Markdown into the single plan file below. The pet reads it, shows only THREE
// rows at a time (just done / doing now / up next), and you click to roll forward/back.
// It auto-refreshes when the file changes, and writes your progress back.
//
//  ┌─────────────────────────────────────────────────────────────────────┐
//  │  CHANGE YOUR VAULT PATH HERE                                          │
//  └─────────────────────────────────────────────────────────────────────┘
const VAULT_PATH = "/Users/yyukin0/Documents/obsidian"; // <-- your Obsidian vault root
const SUBDIR = "Study Plans";                            // <-- subfolder for the plan
const PLAN_FILE = `${VAULT_PATH}/${SUBDIR}/current.md`;  // the one file the pet shows
// ============================================================================

const AUTOSAVE_DELAY_MS = 800; // debounce before writing progress to disk
const POLL_MS = 2500;          // how often to check the file for LLM edits

// --- Tauri bridge (withGlobalTauri = true, so no bundler / npm import needed) ---
const T: any = (window as any).__TAURI__;
const invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any> = T.core.invoke;

// --- Pixel Kirby sprite (the art you approved) ------------------------------
const PET_MAP = [
  "......pppp......",
  "....pppppppp....",
  "...pppppppppp...",
  "..pppppppppppp..",
  "..pppppppppppp..",
  "..pppwwppwwppp..",
  ".ppppeeppeepppp.",
  "pppppeeppeeppppp",
  "pppppppmmppppppp",
  "..pppppppppppp..",
  "..pppppppppppp..",
  "...pppppppppp...",
  "..ffff....ffff..",
  "..ffff....ffff..",
  "..ffff....ffff..",
];
const PET_COLORS: Record<string, string> = {
  p: "#f7a8cd", e: "#2a2c66", w: "#ffffff", f: "#ef5f86", m: "#c85c88",
};
const PET_S = 7;
const px = (x: number, y: number, c: string) =>
  `<rect x="${x * PET_S}" y="${y * PET_S}" width="${PET_S}" height="${PET_S}" fill="${c}"/>`;

// The sprite ships as layers: the body (with open eyes baked in) plus overlay
// groups for each expression. main.ts fades a group in/out to change the face
// (blink / happy ^_^ / sleeping ‿) and to puff the cheeks when inhaling.
function buildPet(): string {
  const cols = PET_MAP[0].length, rows = PET_MAP.length;
  const P = PET_COLORS.p, E = PET_COLORS.e, BLUSH = "#f9c3da";
  let body = "";
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const ch = PET_MAP[r][c];
      if (ch !== ".") body += px(c, r, PET_COLORS[ch]);
    }
  // Paint over the open eyes (cols 5,6,9,10 · rows 5-7) then draw a new face.
  let cover = "";
  for (const c of [5, 6, 9, 10]) for (const r of [5, 6, 7]) cover += px(c, r, P);
  const draw = (pts: number[][]) => pts.map(([x, y]) => px(x, y, E)).join("");
  const blink = cover + draw([[5, 7], [6, 7], [9, 7], [10, 7]]);            // — —
  const happy = cover + draw([[4, 7], [5, 6], [6, 7], [9, 7], [10, 6], [11, 7]]); // ^ ^
  const sleep = cover + draw([[4, 6], [5, 7], [6, 6], [9, 6], [10, 7], [11, 6]]); // ‿ ‿
  const cheek = [[2, 8], [3, 8], [12, 8], [13, 8]].map(([x, y]) => px(x, y, BLUSH)).join("");
  return `<svg width="${cols * PET_S}" height="${rows * PET_S}" viewBox="0 0 ${cols * PET_S} ${rows * PET_S}" xmlns="http://www.w3.org/2000/svg">`
    + `<g>${body}</g>`
    + `<g class="lyr-cheek">${cheek}</g>`
    + `<g class="lyr-blink">${blink}</g>`
    + `<g class="lyr-happy">${happy}</g>`
    + `<g class="lyr-sleep">${sleep}</g>`
    + `</svg>`;
}

// --- Data model -------------------------------------------------------------
type Item =
  | { kind: "heading"; level: number; text: string }
  | { kind: "task"; text: string; initDone: boolean }
  | { kind: "note"; text: string }
  | { kind: "blank" };

interface PlanState {
  title: string;
  created: string;
  items: Item[];
  taskIdx: number[]; // indices into items[] that are tasks, in order
  cursor: number;    // how many tasks are completed (linear progress)
}

let state: PlanState = { title: "", created: "", items: [], taskIdx: [], cursor: 0 };
let saveTimer: number | undefined;
let lastContent = ""; // last file text we read or wrote — to detect external (LLM) edits

// --- DOM refs ---------------------------------------------------------------
const $ = (id: string) => document.getElementById(id)!;
const ptitle = $("ptitle");
const progEl = $("prog");
const tasksEl = $("tasks");
const petEl = $("pet");

function cleanTaskText(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")   // bold
    .replace(/__([^_]+)__/g, "$1")       // bold alt
    .replace(/_([^_]+)_/g, "$1")         // italic
    .replace(/`([^`]+)`/g, "$1")         // inline code
    .trim();
}

// --- Parsing ----------------------------------------------------------------
function parse(text: string): Item[] {
  const items: Item[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") { items.push({ kind: "blank" }); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { items.push({ kind: "heading", level: h[1].length, text: h[2].trim() }); continue; }
    const cb = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (cb) { items.push({ kind: "task", initDone: cb[1].toLowerCase() === "x", text: cleanTaskText(cb[2].trim()) }); continue; }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) { items.push({ kind: "task", initDone: false, text: cleanTaskText(bullet[1].trim()) }); continue; }
    const num = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (num) { items.push({ kind: "task", initDone: false, text: cleanTaskText(num[1].trim()) }); continue; }
    items.push({ kind: "note", text: line.trim() });
  }
  return items;
}

function taskText(taskPos: number): string {
  const it = state.items[state.taskIdx[taskPos]];
  return it && it.kind === "task" ? it.text : "";
}

// Title = first heading in the plan. No fabricated fallback name.
function firstHeading(items: Item[]): string {
  const h = items.find((i) => i.kind === "heading") as { text: string } | undefined;
  return h && h.text ? h.text : "";
}

// --- Dates ------------------------------------------------------------------
const pad = (n: number) => (n < 10 ? "0" + n : String(n));
const fmtDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDateTime = (d: Date) => `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// --- Rendering the 3-row window ---------------------------------------------
function checkSvg(): string {
  return '<span class="check"><svg width="11" height="11" viewBox="0 0 12 12"><path d="M2 6.5 L5 9 L10 3" fill="none" stroke="#0d0f12" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
}
function makeRow(taskPos: number, cls: string, tag: string, onClick?: () => void): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "row " + cls;
  li.innerHTML = `<span class="tag">${tag}</span>${checkSvg()}<span class="label"></span>`;
  li.querySelector(".label")!.textContent = taskText(taskPos);
  if (onClick) li.onclick = onClick;
  return li;
}
function render(): void {
  ptitle.textContent = state.title || "Today's plan";
  const total = state.taskIdx.length;
  progEl.textContent = `${state.cursor} / ${total}`;

  tasksEl.innerHTML = "";
  if (total === 0) {
    const li = document.createElement("li");
    li.className = "row alldone empty";
    li.innerHTML = '<span class="tag">No plan yet · ask Claude to write one</span>';
    tasksEl.appendChild(li);
    return;
  }
  if (state.cursor - 1 >= 0) tasksEl.appendChild(makeRow(state.cursor - 1, "done", "DONE", rollBack));
  if (state.cursor < total) tasksEl.appendChild(makeRow(state.cursor, "active", "NOW", complete));
  else {
    const li = document.createElement("li");
    li.className = "row alldone";
    li.innerHTML = '<span class="tag">All done 🎉</span>';
    tasksEl.appendChild(li);
  }
  if (state.cursor + 1 < total) tasksEl.appendChild(makeRow(state.cursor + 1, "next", "NEXT"));
}

// --- Pet animation controller -----------------------------------------------
// Everything the pet does is driven here with the Web Animations API. Idle =
// breathing + random blinks. Actions squash-hop with sparkles. When every task
// is done the pet celebrates once, then curls up and sleeps (slow breathing,
// closed eyes, floating Zzz) until you roll a task back and it yawns awake.
type Mood = "awake" | "sleep";
let mood: Mood = "awake";
let breatheAnim: Animation | undefined;
let zzzTimer: number | undefined;

// Filled in during wire-up (after the sprite is injected).
let petBody: HTMLElement, petFx: HTMLElement, petShadow: HTMLElement;
let lyrCheek: SVGGElement, lyrBlink: SVGGElement, lyrHappy: SVGGElement, lyrSleep: SVGGElement;

// Fade an expression layer in for `ms`, then back out.
function flash(g: SVGGElement, ms: number): void {
  g.style.opacity = "1";
  window.setTimeout(() => { g.style.opacity = "0"; }, ms);
}

function startBreath(slow: boolean): void {
  if (breatheAnim) breatheAnim.cancel();
  const sx = slow ? 1.06 : 1.05, sy = slow ? 0.97 : 0.95;
  breatheAnim = petBody.animate(
    [{ transform: "scale(1,1)" }, { transform: `scale(${sx},${sy})` }, { transform: "scale(1,1)" }],
    { duration: slow ? 4200 : 2600, iterations: Infinity, easing: "ease-in-out" },
  );
}

// A transient squash-stretch hop. It layers over the infinite breathing and
// hands control back to it when it finishes.
function hop(height: number, dur: number): void {
  petBody.animate([
    { transform: "translateY(0) scale(1,1)" },
    { transform: "translateY(0) scale(1.18,0.82)", offset: 0.14 },
    { transform: `translateY(${-height}px) scale(0.9,1.1)`, offset: 0.5 },
    { transform: "translateY(0) scale(1.12,0.88)", offset: 0.86 },
    { transform: "translateY(0) scale(1,1)" },
  ], { duration: dur, easing: "cubic-bezier(.3,.7,.3,1)" });
  petShadow.animate([
    { transform: "translateX(-50%) scale(1)", opacity: 0.22 },
    { transform: "translateX(-50%) scale(0.7)", opacity: 0.1, offset: 0.5 },
    { transform: "translateX(-50%) scale(1)", opacity: 0.22 },
  ], { duration: dur, easing: "ease-in-out" });
}

// Little diamond particles bursting up out of the pet.
function spark(n: number, colors: string[]): void {
  for (let i = 0; i < n; i++) {
    const s = document.createElement("div");
    const size = 3 + Math.random() * 4;
    s.style.cssText = `position:absolute;left:50%;top:36%;width:${size}px;height:${size}px;background:${colors[i % colors.length]};border-radius:1px;transform:rotate(45deg);`;
    petFx.appendChild(s);
    const ang = (-70 + Math.random() * 140) * Math.PI / 180, dist = 34 + Math.random() * 40;
    const a = s.animate([
      { transform: "translate(-50%,-50%) rotate(45deg) scale(1)", opacity: 1 },
      { transform: `translate(${Math.sin(ang) * dist - 50}%,${-Math.cos(ang) * dist - 50}%) rotate(160deg) scale(0)`, opacity: 0 },
    ], { duration: 560 + Math.random() * 260, easing: "cubic-bezier(.2,.6,.3,1)" });
    a.onfinish = () => s.remove();
  }
}

// Random blinking — runs forever but only shows while awake and visible.
function blinkLoop(): void {
  window.setTimeout(() => {
    if (mood === "awake" && !document.hidden) flash(lyrBlink, 120);
    blinkLoop();
  }, 2200 + Math.random() * 2800);
}

// Floating "z" that drifts up and fades, spawned on a loop while sleeping.
function spawnZ(): void {
  const z = document.createElement("div");
  z.className = "zzz";
  z.textContent = "z";
  z.style.cssText = `position:absolute;left:62%;top:26%;font-size:${9 + Math.random() * 5}px;`;
  petFx.appendChild(z);
  const a = z.animate([
    { transform: "translate(0,0) rotate(-6deg)", opacity: 0 },
    { transform: "translate(6px,-10px) rotate(4deg)", opacity: 0.9, offset: 0.3 },
    { transform: "translate(16px,-30px) rotate(10deg)", opacity: 0 },
  ], { duration: 1900, easing: "ease-out" });
  a.onfinish = () => z.remove();
}
function startZzz(): void {
  stopZzz();
  const tick = () => { if (mood !== "sleep") return; spawnZ(); zzzTimer = window.setTimeout(tick, 1400); };
  tick();
}
function stopZzz(): void {
  if (zzzTimer !== undefined) { clearTimeout(zzzTimer); zzzTimer = undefined; }
}

// --- Mood transitions -------------------------------------------------------
function enterSleep(celebrate: boolean): void {
  if (mood === "sleep") return;
  mood = "sleep";
  const settle = () => {
    lyrHappy.style.opacity = "0";
    lyrBlink.style.opacity = "0";
    lyrSleep.style.opacity = "1";
    petBody.style.opacity = "0.92";
    startBreath(true);
    startZzz();
  };
  if (celebrate) {
    lyrSleep.style.opacity = "0";
    flash(lyrHappy, 1300);
    hop(42, 720);
    window.setTimeout(() => hop(20, 520), 260);
    spark(12, ["#ffd76a", "#f7a8cd", "#7ee0ac", "#85b7eb"]);
    window.setTimeout(() => spark(10, ["#ffd76a", "#f7a8cd", "#ef5f86"]), 160);
    window.setTimeout(settle, 1350);
  } else {
    settle();
  }
}
function enterAwake(yawn: boolean): void {
  if (mood === "awake") return;
  mood = "awake";
  stopZzz();
  lyrSleep.style.opacity = "0";
  petBody.style.opacity = "1";
  startBreath(false);
  if (yawn) {
    flash(lyrBlink, 220);
    petBody.animate([
      { transform: "scale(1,1)" },
      { transform: "scale(0.9,1.16)", offset: 0.4 },
      { transform: "scale(1.08,0.93)", offset: 0.72 },
      { transform: "scale(1,1)" },
    ], { duration: 760, easing: "ease-in-out" });
  }
}
// Quietly sync the pet to the plan state (used after external file reloads).
function applyMood(): void {
  const done = state.taskIdx.length > 0 && state.cursor >= state.taskIdx.length;
  if (done) enterSleep(false); else enterAwake(false);
}

// --- Interaction feedback ---------------------------------------------------
function petComplete(): void {
  flash(lyrHappy, 900);
  hop(30, 560);
  spark(8, ["#ffd76a", "#f7a8cd"]);
}
function petRollback(): void {
  flash(lyrBlink, 300);
  petBody.animate([
    { transform: "translateX(0) rotate(0)" },
    { transform: "translateX(-5px) rotate(-6deg)" },
    { transform: "translateX(5px) rotate(6deg)" },
    { transform: "translateX(-3px) rotate(-3deg)" },
    { transform: "translateX(0) rotate(0)" },
  ], { duration: 420, easing: "ease-in-out" });
}
// Inhale: puff the cheeks and body while the board gets "slurped" in (CSS).
function puff(): void {
  lyrCheek.style.opacity = "1";
  if (mood === "awake") flash(lyrBlink, 160);
  const a = petBody.animate([
    { transform: "scale(1,1)" },
    { transform: "scale(1.18,1.12)", offset: 0.4 },
    { transform: "scale(1.18,1.12)", offset: 0.7 },
    { transform: "scale(1,1)" },
  ], { duration: 820, easing: "ease-in-out" });
  a.onfinish = () => { lyrCheek.style.opacity = "0"; };
}
function exhale(): void {
  petBody.animate([
    { transform: "scale(1,1)" },
    { transform: "scale(0.9,1.12)", offset: 0.4 },
    { transform: "scale(1.05,0.96)", offset: 0.72 },
    { transform: "scale(1,1)" },
  ], { duration: 520, easing: "ease-in-out" });
}
// Quick "boing" when you grab the pet (a native window-drag starts here too).
function pickup(): void {
  petBody.animate([
    { transform: "translateY(0) scale(1,1) rotate(0)" },
    { transform: "translateY(-6px) scale(1.06,0.94) rotate(-4deg)", offset: 0.5 },
    { transform: "translateY(0) scale(1,1) rotate(0)" },
  ], { duration: 300, easing: "ease-out" });
}

function complete(): void {
  if (state.cursor < state.taskIdx.length) {
    state.cursor++;
    if (state.cursor >= state.taskIdx.length) enterSleep(true);
    else petComplete();
    render();
    scheduleSave();
  }
}
function rollBack(): void {
  if (state.cursor > 0) {
    const wasDone = state.cursor >= state.taskIdx.length;
    state.cursor--;
    if (wasDone) enterAwake(true);
    else petRollback();
    render();
    scheduleSave();
  }
}

// --- Serialization (whole plan -> markdown) ---------------------------------
function toMarkdown(): string {
  const total = state.taskIdx.length;
  const fm = [
    "---",
    `title: ${state.title}`,
    `created: ${state.created}`,
    `updated: ${fmtDateTime(new Date())}`,
    `progress: ${state.cursor}/${total}`,
    "---",
  ];
  // task done state is driven purely by the linear cursor
  const donePos = new Map<number, boolean>();
  state.taskIdx.forEach((_, pos) => donePos.set(state.taskIdx[pos], pos < state.cursor));

  const body: string[] = [];
  state.items.forEach((it, idx) => {
    if (it.kind === "blank") body.push("");
    else if (it.kind === "heading") body.push("#".repeat(it.level) + " " + it.text);
    else if (it.kind === "note") body.push(it.text);
    else body.push(`- [${donePos.get(idx) ? "x" : " "}] ${it.text}`);
  });
  return fm.join("\n") + "\n\n" + body.join("\n") + "\n";
}

// --- Deserialization --------------------------------------------------------
function splitFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { fm: {}, body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === "---") { end = i; break; }
  if (end === -1) return { fm: {}, body: text };
  const fm: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return { fm, body: lines.slice(end + 1).join("\n").replace(/^\n+/, "") };
}

// --- Saving -----------------------------------------------------------------
function scheduleSave(): void {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, AUTOSAVE_DELAY_MS);
}
async function save(): Promise<void> {
  if (saveTimer !== undefined) { clearTimeout(saveTimer); saveTimer = undefined; }
  if (state.items.length === 0) return;
  const md = toMarkdown();
  try {
    await invoke("write_atomic", { path: PLAN_FILE, contents: md });
    lastContent = md; // so our own write doesn't look like an external edit
  } catch (e) {
    console.error(e);
  }
}

// --- Load from the plan file ------------------------------------------------
function adopt(items: Item[], created: string): void {
  const taskIdx: number[] = [];
  items.forEach((it, i) => { if (it.kind === "task") taskIdx.push(i); });
  // cursor = number of leading completed tasks (first not-done task)
  let cursor = taskIdx.length;
  for (let pos = 0; pos < taskIdx.length; pos++) {
    const it = items[taskIdx[pos]];
    if (it.kind === "task" && !it.initDone) { cursor = pos; break; }
  }
  state = { title: firstHeading(items), created: created || fmtDate(new Date()), items, taskIdx, cursor };
  render();
  applyMood();
}

async function loadFile(): Promise<void> {
  try {
    const text = await invoke("read_text", { path: PLAN_FILE });
    lastContent = text;
    const { fm, body } = splitFrontmatter(text);
    adopt(parse(body), fm.created || "");
    if (fm.title) { state.title = fm.title; render(); }
  } catch {
    // File not there yet — empty state; keep polling so it appears once written.
    lastContent = "";
    state = { title: "", created: "", items: [], taskIdx: [], cursor: 0 };
    render();
  }
}

// Poll for external (LLM) edits and reload when the file changed under us,
// unless we have a pending save (don't clobber the user's in-flight clicks).
async function poll(): Promise<void> {
  if (saveTimer !== undefined) return;
  try {
    const text = await invoke("read_text", { path: PLAN_FILE });
    if (text !== lastContent) await loadFile();
  } catch {
    if (lastContent !== "") await loadFile(); // file was removed
  }
}

// --- Wire up ----------------------------------------------------------------
const boardEl = document.querySelector(".board") as HTMLElement;

// The pet is a stack: a ground shadow, the sprite body (what we animate), and
// an fx layer for sparkles / Zzz. Children are pointer-events:none so mousedown
// falls through to #pet (the window drag region).
petEl.innerHTML = `<div class="pet-shadow"></div><div class="pet-body">${buildPet()}</div><div class="pet-fx"></div>`;
petShadow = petEl.querySelector(".pet-shadow") as HTMLElement;
petBody = petEl.querySelector(".pet-body") as HTMLElement;
petFx = petEl.querySelector(".pet-fx") as HTMLElement;
lyrCheek = petBody.querySelector(".lyr-cheek") as unknown as SVGGElement;
lyrBlink = petBody.querySelector(".lyr-blink") as unknown as SVGGElement;
lyrHappy = petBody.querySelector(".lyr-happy") as unknown as SVGGElement;
lyrSleep = petBody.querySelector(".lyr-sleep") as unknown as SVGGElement;

startBreath(false);
blinkLoop();

// Grabbing the pet gives a little boing (a native drag also starts here).
// (left button only — right button opens the quit menu instead)
petEl.addEventListener("mousedown", (e) => { if (e.button === 0) pickup(); });
// A plain (left) click collapses / expands the board. The pet stays put; the
// board is scaled away with a transform so it keeps its layout box (styles.css).
petEl.addEventListener("click", () => {
  const collapsing = !boardEl.classList.contains("collapsed");
  boardEl.classList.toggle("collapsed");
  if (collapsing) puff(); else exhale();
});

// Right-click the pet → a little "Quit Kirby" menu. Click it to quit the app.
const menuEl = $("petmenu") as HTMLElement;
petEl.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  menuEl.hidden = false;
  const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
  const x = Math.max(6, Math.min(e.clientX, window.innerWidth - mw - 6));
  const y = Math.max(6, Math.min(e.clientY - mh - 6, window.innerHeight - mh - 6));
  menuEl.style.left = `${x}px`;
  menuEl.style.top = `${y}px`;
});
// Dismiss the menu on any click / Escape that isn't the menu itself.
document.addEventListener("mousedown", (e) => {
  if (!menuEl.hidden && !menuEl.contains(e.target as Node)) menuEl.hidden = true;
}, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") menuEl.hidden = true; });
$("quit").addEventListener("click", async (e) => {
  e.stopPropagation();
  menuEl.hidden = true;
  try { await T.window.getCurrentWindow().close(); } catch (err) { console.error(err); }
});

loadFile();
setInterval(poll, POLL_MS);
