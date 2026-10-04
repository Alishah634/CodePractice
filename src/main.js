import { EditorState, Compartment, Prec, RangeSetBuilder, StateField, StateEffect } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, rectangularSelection, crosshairCursor, highlightSpecialChars,
  Decoration, WidgetType,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, insertNewline } from "@codemirror/commands";
import {
  syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput,
  indentService, indentUnit,
} from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { vim, Vim } from "@replit/codemirror-vim";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { sql } from "@codemirror/lang-sql";

// ---------------------------------------------------------------------------
// Languages

const LANGS = {
  plain: { label: "Plain text", ext: () => [] },
  python: { label: "Python", ext: () => python() },
  javascript: { label: "JavaScript", ext: () => javascript() },
  typescript: { label: "TypeScript", ext: () => javascript({ typescript: true }) },
  jsx: { label: "JSX / TSX", ext: () => javascript({ jsx: true, typescript: true }) },
  cpp: { label: "C / C++", ext: () => cpp() },
  java: { label: "Java", ext: () => java() },
  rust: { label: "Rust", ext: () => rust() },
  go: { label: "Go", ext: () => go() },
  html: { label: "HTML", ext: () => html() },
  css: { label: "CSS", ext: () => css() },
  json: { label: "JSON", ext: () => json() },
  sql: { label: "SQL", ext: () => sql() },
};

const EXT_TO_LANG = {
  py: "python", pyw: "python",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", mts: "typescript", jsx: "jsx", tsx: "jsx",
  c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", ino: "cpp",
  java: "java", kt: "java", cs: "java", scala: "java",
  rs: "rust", go: "go",
  html: "html", htm: "html", vue: "html", svelte: "html",
  css: "css", scss: "css", less: "css",
  json: "json", sql: "sql",
};

function langFromName(name) {
  const m = /\.([^.]+)$/.exec(name || "");
  return (m && EXT_TO_LANG[m[1].toLowerCase()]) || "plain";
}

// ---------------------------------------------------------------------------
// Persistent storage (wrapped: storage can be unavailable)

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem("codetype:" + key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem("codetype:" + key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

const DEFAULT_SETTINGS = {
  vim: true,
  ghost: true,
  blind: false,
  ignoreTrailing: true,
  ignoreIndent: false,
  indentMode: "keep", // smart | keep | none
  theme: "dark",
};
const settings = { ...DEFAULT_SETTINGS, ...store.get("settings", {}) };
const saveSettings = () => store.set("settings", settings);

// ---------------------------------------------------------------------------
// Snippet library: repo snippets (embedded at build time) + user snippets

/* global __SNIPPETS__ */
const REPO_SNIPPETS = (typeof __SNIPPETS__ !== "undefined" ? __SNIPPETS__ : []).map((s) => ({
  id: "repo:" + s.path,
  name: s.path,
  code: s.code,
  lang: langFromName(s.path),
  repo: true,
}));

const DEMO = {
  id: "demo",
  name: "demo.py",
  lang: "python",
  repo: true,
  code: `def fizzbuzz(n):
    """Return the FizzBuzz sequence up to n."""
    out = []
    for i in range(1, n + 1):
        if i % 15 == 0:
            out.append("FizzBuzz")
        elif i % 3 == 0:
            out.append("Fizz")
        elif i % 5 == 0:
            out.append("Buzz")
        else:
            out.append(str(i))
    return out


if __name__ == "__main__":
    print("\\n".join(fizzbuzz(15)))
`,
};

let userSnippets = store.get("snippets", []);
const saveUserSnippets = () => store.set("snippets", userSnippets);

function allSnippets() {
  const repo = REPO_SNIPPETS.length ? REPO_SNIPPETS : [DEMO];
  return [...repo, ...userSnippets];
}

function findSnippet(id) {
  return allSnippets().find((s) => s.id === id) || allSnippets()[0];
}

// ---------------------------------------------------------------------------
// Comparison logic

function normalizeCode(text) {
  // Normalise newlines and drop trailing blank lines so finishing doesn't
  // depend on whether you typed the final newline.
  return text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
}

function normLine(line) {
  let s = line;
  if (settings.ignoreTrailing) s = s.replace(/\s+$/, "");
  if (settings.ignoreIndent) s = s.replace(/^\s+/, "");
  return s;
}

/** Leading whitespace length that should be skipped when ignoring indent. */
function indentLen(line) {
  return settings.ignoreIndent ? /^\s*/.exec(line)[0].length : 0;
}

/**
 * Compare the typed document against the target, line by line.
 * Returns per-line status: "ok" | "partial" (correct prefix) | "error" | "empty".
 */
function compare(typedLines, targetLines) {
  const lines = [];
  let correctChars = 0;
  let okCount = 0;
  for (let i = 0; i < Math.max(typedLines.length, targetLines.length); i++) {
    const u = typedLines[i];
    const t = targetLines[i];
    if (u === undefined) { lines.push({ status: "empty" }); continue; }
    if (t === undefined) {
      lines.push(u.trim() === "" ? { status: "empty" } : { status: "error", col: 0 });
      continue;
    }
    const nu = normLine(u), nt = normLine(t);
    if (nu === nt) {
      lines.push({ status: "ok" });
      okCount++;
      correctChars += nt.length;
      continue;
    }
    // Find first differing column (in the raw typed line).
    const offU = indentLen(u), offT = indentLen(t);
    let k = 0;
    while (offU + k < u.length && offT + k < t.length && u[offU + k] === t[offT + k]) k++;
    correctChars += k;
    if (offU + k >= u.replace(/\s+$/, "").length && (settings.ignoreTrailing || offU + k >= u.length)) {
      // Everything typed so far is a correct prefix of the target line.
      lines.push(u === "" ? { status: "empty" } : { status: "partial", col: offU + k, tcol: offT + k });
    } else {
      lines.push({ status: "error", col: offU + k, tcol: offT + k });
    }
  }
  const finished = okCount === targetLines.length &&
    typedLines.slice(targetLines.length).every((l) => l.trim() === "");
  return { lines, correctChars, okCount, finished };
}

// ---------------------------------------------------------------------------
// Decorations

const setTypedDecos = StateEffect.define();
const setTargetDecos = StateEffect.define();

function decoField(effect) {
  return StateField.define({
    create: () => Decoration.none,
    update(decos, tr) {
      decos = decos.map(tr.changes);
      for (const e of tr.effects) if (e.is(effect)) decos = e.value;
      return decos;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}
const typedDecoField = decoField(setTypedDecos);
const targetDecoField = decoField(setTargetDecos);

class GhostWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(other) { return other.text === this.text; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-ghost";
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() { return true; }
}

const lineDeco = {
  ok: Decoration.line({ class: "ln-ok" }),
  error: Decoration.line({ class: "ln-error" }),
  partial: Decoration.line({ class: "ln-partial" }),
};
const markError = Decoration.mark({ class: "ch-error" });
const markCursor = Decoration.mark({ class: "ch-cursor" });
const targetCurrent = Decoration.line({ class: "ln-current" });

// ---------------------------------------------------------------------------
// App state

const $ = (sel) => document.querySelector(sel);

const app = {
  snippet: null,
  targetText: "",
  targetLines: [],
  rangeStart: 1, // 1-based line number in the snippet where the range starts
  startTime: null,
  endTime: null,
  keystrokes: 0,
  mistakes: 0,
  prevErrorLines: new Set(),
  result: null,
  timer: null,
};

const themeComp = new Compartment();
const vimComp = new Compartment();
const langComp = new Compartment();
const tLangComp = new Compartment();
const indentComp = new Compartment();
const gutterComp = new Compartment();
const tGutterComp = new Compartment();

function themeExt() {
  return settings.theme === "dark" ? oneDark : syntaxHighlighting(defaultHighlightStyle, { fallback: true });
}

function lineNumberExt() {
  return lineNumbers({ formatNumber: (n) => String(n + app.rangeStart - 1) });
}

function detectIndentUnit(text) {
  const lines = text.split("\n");
  if (lines.some((l) => /^\t/.test(l))) return "\t";
  const counts = {};
  for (const l of lines) {
    const m = /^( +)\S/.exec(l);
    if (m) counts[m[1].length] = (counts[m[1].length] || 0) + 1;
  }
  const widths = Object.keys(counts).map(Number);
  if (!widths.length) return "    ";
  const min = Math.min(...widths);
  return " ".repeat(min >= 2 && min <= 8 ? min : 4);
}

function indentExt() {
  const unit = detectIndentUnit(app.targetText);
  const exts = [indentUnit.of(unit)];
  if (settings.indentMode === "none") {
    exts.push(Prec.highest(indentService.of(() => 0)));
  } else if (settings.indentMode === "keep") {
    exts.push(Prec.highest(indentService.of((cx, pos) => cx.lineIndent(pos, -1))));
  } else {
    exts.push(indentOnInput());
  }
  // Tab inserts one indent unit (also works in vim insert mode).
  exts.push(Prec.high(keymap.of([{
    key: "Tab",
    run: (view) => {
      view.dispatch(view.state.replaceSelection(unit));
      return true;
    },
  }])));
  if (settings.indentMode === "none") {
    exts.push(Prec.high(keymap.of([{ key: "Enter", run: insertNewline }])));
  }
  return exts;
}

const baseTheme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55" },
});

// Typing editor ------------------------------------------------------------

const typedView = new EditorView({
  parent: $("#typed"),
  state: EditorState.create({
    doc: "",
    extensions: [
      vimComp.of(settings.vim ? vim({ status: true }) : []),
      gutterComp.of(lineNumberExt()),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      EditorState.allowMultipleSelections.of(true),
      rectangularSelection(),
      crosshairCursor(),
      bracketMatching(),
      highlightActiveLine(),
      indentComp.of([]),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      langComp.of([]),
      themeComp.of(themeExt()),
      baseTheme,
      typedDecoField,
      EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off" }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onTypedChange(u);
        if (u.docChanged || u.selectionSet || u.focusChanged) refreshDecorations();
      }),
    ],
  }),
});

typedView.contentDOM.addEventListener("keydown", (e) => {
  if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
  if (app.endTime) return;
  app.keystrokes++;
}, true);

// Target (read-only) view --------------------------------------------------

const targetView = new EditorView({
  parent: $("#target"),
  state: EditorState.create({
    doc: "",
    extensions: [
      tGutterComp.of(lineNumberExt()),
      highlightSpecialChars(),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      tLangComp.of([]),
      themeComp.of(themeExt()),
      baseTheme,
      targetDecoField,
    ],
  }),
});

// ---------------------------------------------------------------------------
// Updating

function typedLinesOf(state) {
  return state.doc.toString().split("\n");
}

function onTypedChange() {
  if (app.endTime) return;
  if (!app.startTime && typedView.state.doc.length > 0) {
    app.startTime = performance.now();
    startTimer();
  }
  const cmp = compare(typedLinesOf(typedView.state), app.targetLines);
  const errorLines = new Set();
  cmp.lines.forEach((l, i) => { if (l.status === "error") errorLines.add(i); });
  for (const i of errorLines) if (!app.prevErrorLines.has(i)) app.mistakes++;
  app.prevErrorLines = errorLines;
  if (cmp.finished) finish(cmp);
}

function refreshDecorations() {
  const state = typedView.state;
  const doc = state.doc;
  const typedLines = typedLinesOf(state);
  const cmp = compare(typedLines, app.targetLines);
  const head = state.selection.main.head;
  const curLine = doc.lineAt(head);
  const curIdx = curLine.number - 1;

  // Typed editor decorations.
  const b = new RangeSetBuilder();
  for (let i = 0; i < doc.lines; i++) {
    const line = doc.line(i + 1);
    const info = cmp.lines[i];
    if (!info) continue;
    if (info.status === "ok") b.add(line.from, line.from, lineDeco.ok);
    else if (info.status === "error") {
      b.add(line.from, line.from, lineDeco.error);
      const from = line.from + info.col;
      if (from < line.to) b.add(from, line.to, markError);
    }
    // Ghost text: the rest of the target line, shown at the end of the line
    // the cursor is on, when everything typed so far is correct.
    if (settings.ghost && !settings.blind && i === curIdx && !app.endTime &&
        (info.status === "partial" || info.status === "empty") && head === line.to) {
      const t = app.targetLines[i];
      if (t !== undefined) {
        const rest = info.status === "partial" ? t.slice(info.tcol) : t;
        if (rest) b.add(line.to, line.to, Decoration.widget({ widget: new GhostWidget(rest), side: 1 }));
      }
    }
  }
  typedView.dispatch({ effects: setTypedDecos.of(b.finish()) });

  // Target view decorations: highlight the line/column you're on.
  const tdoc = targetView.state.doc;
  const tb = new RangeSetBuilder();
  if (curIdx < tdoc.lines) {
    const tl = tdoc.line(curIdx + 1);
    tb.add(tl.from, tl.from, targetCurrent);
    const col = Math.min(head - curLine.from, tl.length);
    if (col < tl.length) tb.add(tl.from + col, tl.from + col + 1, markCursor);
  }
  targetView.dispatch({ effects: setTargetDecos.of(tb.finish()) });

  // Keep the target scrolled to the same line.
  if (curIdx < tdoc.lines) {
    const tl = tdoc.line(curIdx + 1);
    const typedBlock = typedView.lineBlockAt(curLine.from);
    const targetBlock = targetView.lineBlockAt(tl.from);
    const offset = typedBlock.top - typedView.scrollDOM.scrollTop;
    const want = targetBlock.top - offset;
    if (Math.abs(targetView.scrollDOM.scrollTop - want) > 1) targetView.scrollDOM.scrollTop = want;
  }

  updateStats(cmp);
}

// ---------------------------------------------------------------------------
// Stats / timer

function elapsedMs() {
  if (!app.startTime) return 0;
  return (app.endTime || performance.now()) - app.startTime;
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function wpm(chars, ms) {
  if (ms < 1000) return 0;
  return Math.round(chars / 5 / (ms / 60000));
}

let lastCmp = null;
function updateStats(cmp) {
  if (cmp) lastCmp = cmp;
  cmp = lastCmp;
  if (!cmp) return;
  const ms = elapsedMs();
  const total = app.targetLines.length || 1;
  $("#stat-time").textContent = fmtTime(ms);
  $("#stat-wpm").textContent = wpm(cmp.correctChars, ms);
  $("#stat-lines").textContent = `${cmp.okCount}/${app.targetLines.length}`;
  $("#stat-keys").textContent = app.keystrokes;
  $("#stat-mistakes").textContent = app.mistakes;
  $("#progress").style.width = `${(100 * cmp.okCount) / total}%`;
}

function startTimer() {
  stopTimer();
  app.timer = setInterval(() => updateStats(), 250);
}
function stopTimer() {
  if (app.timer) clearInterval(app.timer);
  app.timer = null;
}

function targetCharCount() {
  return app.targetLines.reduce((n, l) => n + normLine(l).length, 0) + app.targetLines.length - 1;
}

function historyKey() {
  return `history:${app.snippet.id}:${app.rangeStart}-${app.rangeStart + app.targetLines.length - 1}`;
}

function finish(cmp) {
  app.endTime = performance.now();
  stopTimer();
  updateStats(cmp);
  const ms = elapsedMs();
  const chars = targetCharCount();
  const result = {
    date: new Date().toISOString(),
    ms,
    wpm: wpm(chars, ms),
    keystrokes: app.keystrokes,
    mistakes: app.mistakes,
    chars,
    vim: settings.vim,
  };
  const hist = store.get(historyKey(), []);
  const best = hist.reduce((b, r) => (!b || r.ms < b.ms ? r : b), null);
  hist.push(result);
  store.set(historyKey(), hist.slice(-50));

  $("#r-time").textContent = fmtTime(ms);
  $("#r-wpm").textContent = result.wpm;
  $("#r-keys").textContent = result.keystrokes;
  $("#r-kpc").textContent = chars ? (result.keystrokes / chars).toFixed(2) : "–";
  $("#r-mistakes").textContent = result.mistakes;
  $("#r-best").textContent = !best ? "First run — that's your best!"
    : ms < best.ms ? `New personal best! (previous ${fmtTime(best.ms)}, ${best.wpm} wpm)`
    : `Personal best: ${fmtTime(best.ms)}, ${best.wpm} wpm`;
  $("#r-runs").textContent = hist.length;
  $("#results").showModal();
}

// ---------------------------------------------------------------------------
// Loading a snippet

function loadSnippet(id, { keepRange = false } = {}) {
  const snip = findSnippet(id);
  app.snippet = snip;
  store.set("current", snip.id);
  const all = normalizeCode(snip.code).split("\n");
  if (!keepRange) {
    const saved = store.get("range:" + snip.id, null);
    $("#range-from").value = saved ? saved[0] : 1;
    $("#range-to").value = saved ? saved[1] : all.length;
  }
  let from = Math.max(1, Math.min(all.length, parseInt($("#range-from").value, 10) || 1));
  let to = Math.max(from, Math.min(all.length, parseInt($("#range-to").value, 10) || all.length));
  $("#range-from").value = from;
  $("#range-to").value = to;
  $("#range-from").max = $("#range-to").max = all.length;
  $("#range-total").textContent = `of ${all.length}`;
  store.set("range:" + snip.id, [from, to]);

  app.rangeStart = from;
  app.targetLines = all.slice(from - 1, to);
  app.targetText = app.targetLines.join("\n");
  $("#lang").value = snip.lang in LANGS ? snip.lang : "plain";
  $("#snippet").value = snip.id;
  $("#delete-snippet").disabled = !!snip.repo;

  targetView.dispatch({
    changes: { from: 0, to: targetView.state.doc.length, insert: app.targetText },
    effects: [
      tLangComp.reconfigure(LANGS[$("#lang").value].ext()),
      tGutterComp.reconfigure(lineNumberExt()),
    ],
  });
  targetView.scrollDOM.scrollTop = 0;
  restart();
}

function restart() {
  stopTimer();
  app.startTime = null;
  app.endTime = null;
  app.keystrokes = 0;
  app.mistakes = 0;
  app.prevErrorLines = new Set();
  typedView.dispatch({
    changes: { from: 0, to: typedView.state.doc.length, insert: "" },
    selection: { anchor: 0 },
    effects: [
      langComp.reconfigure(LANGS[$("#lang").value].ext()),
      indentComp.reconfigure(indentExt()),
      gutterComp.reconfigure(lineNumberExt()),
    ],
  });
  typedView.scrollDOM.scrollTop = 0;
  // Leave vim in normal mode on a fresh start so `i`, `o`, etc. work as expected.
  refreshDecorations();
  updateStats();
  typedView.focus();
}

function renderSnippetList() {
  const sel = $("#snippet");
  sel.innerHTML = "";
  const repo = allSnippets().filter((s) => s.repo);
  const mine = allSnippets().filter((s) => !s.repo);
  const group = (label, items) => {
    if (!items.length) return;
    const g = document.createElement("optgroup");
    g.label = label;
    for (const s of items) {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.name;
      g.appendChild(o);
    }
    sel.appendChild(g);
  };
  group(REPO_SNIPPETS.length ? "Repo snippets" : "Example", repo);
  group("My snippets", mine);
}

function addUserSnippet(name, code) {
  const id = "user:" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  userSnippets.push({ id, name, code, lang: langFromName(name) });
  saveUserSnippets();
  renderSnippetList();
  loadSnippet(id);
}

// ---------------------------------------------------------------------------
// UI wiring

function applySettingsToUI() {
  $("#opt-vim").checked = settings.vim;
  $("#opt-ghost").checked = settings.ghost;
  $("#opt-blind").checked = settings.blind;
  $("#opt-trailing").checked = settings.ignoreTrailing;
  $("#opt-indent").checked = settings.ignoreIndent;
  $("#opt-indent-mode").value = settings.indentMode;
  document.documentElement.dataset.theme = settings.theme;
  document.body.classList.toggle("blind", settings.blind);
}

function bindSetting(id, key, onChange) {
  $(id).addEventListener("change", (e) => {
    settings[key] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    saveSettings();
    applySettingsToUI();
    onChange && onChange();
    refreshDecorations();
    typedView.focus();
  });
}

bindSetting("#opt-vim", "vim", () => {
  typedView.dispatch({ effects: vimComp.reconfigure(settings.vim ? vim({ status: true }) : []) });
});
bindSetting("#opt-ghost", "ghost");
bindSetting("#opt-blind", "blind");
bindSetting("#opt-trailing", "ignoreTrailing", () => onTypedChange());
bindSetting("#opt-indent", "ignoreIndent", () => onTypedChange());
bindSetting("#opt-indent-mode", "indentMode", () => {
  typedView.dispatch({ effects: indentComp.reconfigure(indentExt()) });
});

$("#theme").addEventListener("click", () => {
  settings.theme = settings.theme === "dark" ? "light" : "dark";
  saveSettings();
  applySettingsToUI();
  for (const v of [typedView, targetView]) v.dispatch({ effects: themeComp.reconfigure(themeExt()) });
});

$("#snippet").addEventListener("change", (e) => loadSnippet(e.target.value));
$("#lang").addEventListener("change", (e) => {
  app.snippet.lang = e.target.value;
  if (!app.snippet.repo) saveUserSnippets();
  const ext = LANGS[e.target.value].ext();
  targetView.dispatch({ effects: tLangComp.reconfigure(ext) });
  typedView.dispatch({ effects: langComp.reconfigure(LANGS[e.target.value].ext()) });
  typedView.focus();
});
for (const id of ["#range-from", "#range-to"]) {
  $(id).addEventListener("change", () => loadSnippet(app.snippet.id, { keepRange: true }));
}
$("#range-all").addEventListener("click", () => {
  $("#range-from").value = 1;
  $("#range-to").value = 1e9;
  loadSnippet(app.snippet.id, { keepRange: true });
});
$("#restart").addEventListener("click", restart);
$("#r-again").addEventListener("click", () => { $("#results").close(); restart(); });
$("#r-close").addEventListener("click", () => $("#results").close());

$("#delete-snippet").addEventListener("click", () => {
  if (app.snippet.repo) return;
  if (!confirm(`Delete "${app.snippet.name}" from your snippets?`)) return;
  userSnippets = userSnippets.filter((s) => s.id !== app.snippet.id);
  saveUserSnippets();
  renderSnippetList();
  loadSnippet(allSnippets()[0].id);
});

// Paste dialog
$("#paste").addEventListener("click", () => {
  $("#paste-name").value = "";
  $("#paste-code").value = "";
  $("#paste-dialog").showModal();
  $("#paste-code").focus();
});
$("#paste-cancel").addEventListener("click", () => $("#paste-dialog").close());
$("#paste-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = $("#paste-code").value;
  if (!code.trim()) return;
  addUserSnippet($("#paste-name").value.trim() || "snippet.txt", code);
  $("#paste-dialog").close();
});
// Tab inside the paste textarea inserts a tab instead of moving focus.
$("#paste-code").addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  e.preventDefault();
  const ta = e.target;
  ta.setRangeText("\t", ta.selectionStart, ta.selectionEnd, "end");
});

// Open files
async function addFiles(files) {
  let last = null;
  for (const f of files) {
    if (f.size > 2_000_000) continue;
    const code = await f.text();
    last = { name: f.name, code };
    const id = "user:" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    userSnippets.push({ id, name: f.name, code, lang: langFromName(f.name) });
    last.id = id;
  }
  if (!last) return;
  saveUserSnippets();
  renderSnippetList();
  loadSnippet(last.id);
}
$("#open").addEventListener("click", () => $("#file").click());
$("#file").addEventListener("change", (e) => { addFiles([...e.target.files]); e.target.value = ""; });
window.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("dragging"); });
window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dragging"); });
window.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]);
});

// Global shortcuts that don't conflict with vim (Alt-based).
window.addEventListener("keydown", (e) => {
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    if (e.code === "KeyR") { e.preventDefault(); restart(); }
    else if (e.code === "KeyB") { e.preventDefault(); $("#opt-blind").click(); }
    else if (e.code === "KeyG") { e.preventDefault(); $("#opt-ghost").click(); }
  }
});

// `:restart` (or `:re`) from vim's command line.
Vim.defineEx("restart", "re", () => restart());

// ---------------------------------------------------------------------------
// Init

for (const [key, { label }] of Object.entries(LANGS)) {
  const o = document.createElement("option");
  o.value = key;
  o.textContent = label;
  $("#lang").appendChild(o);
}
applySettingsToUI();
renderSnippetList();
loadSnippet(store.get("current", allSnippets()[0].id));

// Exposed for debugging / tests.
window.codetype = { app, typedView, targetView, restart, loadSnippet };
