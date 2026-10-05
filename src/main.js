import { EditorState, Compartment, Prec, RangeSetBuilder, StateField, StateEffect } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, rectangularSelection, crosshairCursor, highlightSpecialChars,
  Decoration, WidgetType,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, insertNewline } from "@codemirror/commands";
import {
  autocompletion, closeBrackets, closeBracketsKeymap, completionStatus,
  acceptCompletion, startCompletion, closeCompletion, moveCompletionSelection,
} from "@codemirror/autocomplete";
import {
  syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput,
  indentService, indentUnit,
} from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { vim, Vim, getCM } from "@replit/codemirror-vim";
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

// Keywords for the languages whose CodeMirror package ships no completion
// source of its own (python/javascript/go/html/css/sql bring their own).
const KEYWORDS = {
  cpp: `alignas alignof auto bool break case catch char class const constexpr const_cast continue decltype
    default delete do double dynamic_cast else enum explicit export extern false float for friend goto if
    inline int long mutable namespace new noexcept nullptr operator private protected public register
    reinterpret_cast return short signed sizeof static static_assert static_cast struct switch template this
    throw true try typedef typeid typename union unsigned using virtual void volatile while
    #include #define #ifndef #endif #pragma std::string std::vector std::cout std::endl std::map`,
  java: `abstract assert boolean break byte case catch char class const continue default do double else enum
    extends final finally float for if implements import instanceof int interface long native new package
    private protected public return short static strictfp super switch synchronized this throw throws
    transient try void volatile while true false null var record sealed String System.out.println ArrayList
    HashMap List Map Optional Override`,
  rust: `as async await break const continue crate dyn else enum extern false fn for if impl in let loop match
    mod move mut pub ref return self Self static struct super trait true type unsafe use where while
    String Vec Option Some None Result Ok Err Box Rc Arc HashMap println! vec! derive clone unwrap expect`,
  json: "true false null",
};

/**
 * Identifiers worth suggesting, pulled out of the reference snippet, ranked by
 * how often they appear. Cached, since this runs on every keystroke.
 */
let identifierCache = { text: null, options: [] };
function snippetIdentifiers() {
  if (identifierCache.text === app.targetText) return identifierCache.options;
  const freq = new Map();
  for (const word of app.targetText.match(/[A-Za-z_$][\w$]*/g) || []) {
    if (word.length < 3) continue;
    freq.set(word, (freq.get(word) || 0) + 1);
  }
  const options = [...freq].map(([label, n]) => ({
    label,
    type: "variable",
    detail: "snippet",
    // Frequent identifiers first; CodeMirror still filters by what you typed.
    boost: Math.min(n, 5),
  }));
  identifierCache = { text: app.targetText, options };
  return options;
}

/**
 * Completion source backed by the reference snippet plus whatever is already
 * typed. This is what makes autocomplete genuinely useful here: the words you
 * need are, by definition, the words in the code you're copying.
 */
function snippetCompletionSource(context) {
  const word = context.matchBefore(/[\w$#]+/);
  if (!word || (word.from === word.to && !context.explicit)) return null;

  // Completing a word to itself does nothing, so don't offer it.
  const options = snippetIdentifiers().filter((o) => o.label !== word.text);
  for (const kw of (KEYWORDS[app.snippet?.lang] || "").split(/\s+/)) {
    if (kw && kw !== word.text) options.push({ label: kw, type: "keyword" });
  }
  return { from: word.from, options, validFor: /^[\w$#]*$/ };
}

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
  autocomplete: true,
  brackets: true,
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

// Edits made to repo snippets in the reference pane are kept in the browser as
// overrides; the original stays around so it can be restored.
for (const s of [...REPO_SNIPPETS, DEMO]) {
  s.original = s.code;
  const override = store.get("override:" + s.id, null);
  if (override != null) s.code = override;
}

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

// Characters an editor inserts for you ahead of the cursor (auto-closed
// brackets and quotes). On the line you're on, these are pending, not wrong.
const AUTO_TAIL = /^[)\]}'"`>]*\s*$/;

/**
 * Compare the typed document against the target, line by line.
 * Returns per-line status: "ok" | "partial" (correct prefix) | "error" | "empty".
 *
 * The line the cursor is on is judged only up to the cursor, so an auto-closed
 * bracket sitting to the right of it doesn't light the line up red.
 */
function compare(typedLines, targetLines, cur) {
  const lines = [];
  let correctChars = 0;
  let okCount = 0;
  for (let i = 0; i < Math.max(typedLines.length, targetLines.length); i++) {
    const u = typedLines[i];
    const t = targetLines[i];
    if (u === undefined) { lines.push({ status: "empty" }); continue; }
    if (t === undefined) {
      lines.push(u.trim() === "" ? { status: "empty" } : { status: "error", col: 0, tcol: 0 });
      continue;
    }
    const nu = normLine(u), nt = normLine(t);
    if (nu === nt) {
      lines.push({ status: "ok" });
      okCount++;
      correctChars += nt.length;
      continue;
    }
    const onCursorLine = cur && cur.line === i;
    const judged = onCursorLine ? u.slice(0, cur.col) : u;
    const tail = onCursorLine ? u.slice(cur.col) : "";
    // Find first differing column (in the raw typed line).
    const offU = indentLen(u), offT = indentLen(t);
    let k = 0;
    while (offU + k < judged.length && offT + k < t.length && u[offU + k] === t[offT + k]) k++;
    correctChars += k;
    const judgedEnd = settings.ignoreTrailing ? judged.replace(/\s+$/, "").length : judged.length;
    if (offU + k >= judgedEnd && AUTO_TAIL.test(tail)) {
      // Everything typed so far is a correct prefix of the target line.
      lines.push(u === "" ? { status: "empty", col: 0, tcol: offT }
                          : { status: "partial", col: offU + k, tcol: offT + k });
    } else {
      const col = offU + k >= judgedEnd ? cur.col : offU + k;
      lines.push({ status: "error", col, tcol: offT + k });
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
const completeComp = new Compartment();
const bracketComp = new Compartment();
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

function completionExt() {
  if (!settings.autocomplete) return [];
  return [
    autocompletion({
      // Enter stays a newline and Escape is vim's, so bind acceptance to Tab.
      defaultKeymap: false,
      activateOnTyping: true,
      icons: true,
      tooltipClass: () => "cm-complete-tip",
    }),
    // Suggest identifiers from the reference snippet in every language, on top
    // of whatever completion the language package provides.
    EditorState.languageData.of(() => [{ autocomplete: snippetCompletionSource }]),
    Prec.highest(keymap.of([
      { key: "Ctrl-Space", run: startCompletion },
      { key: "ArrowDown", run: moveCompletionSelection(true) },
      { key: "ArrowUp", run: moveCompletionSelection(false) },
    ])),
    // Escape closes the popup *and* falls through, so vim still leaves insert
    // mode on the same keypress.
    Prec.highest(EditorView.domEventHandlers({
      keydown(e, view) {
        if (e.key === "Escape" && completionStatus(view.state)) closeCompletion(view);
        return false;
      },
    })),
  ];
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
  // Tab accepts the open completion, otherwise inserts one indent unit
  // (also works in vim insert mode).
  exts.push(Prec.high(keymap.of([{
    key: "Tab",
    run: (view) => {
      if (completionStatus(view.state) && acceptCompletion(view)) return true;
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
      completeComp.of([]),
      bracketComp.of([]),
      keymap.of([...defaultKeymap, ...historyKeymap, ...closeBracketsKeymap]),
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

// Target (reference) view: read-only, unless you click Edit ------------------

const tEditComp = new Compartment();
const readOnlyExt = [EditorState.readOnly.of(true), EditorView.editable.of(false)];

function targetEditExt() {
  const unit = detectIndentUnit(app.targetText);
  return [
    settings.vim ? vim({ status: true }) : [],
    history(),
    drawSelection(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    indentUnit.of(unit),
    Prec.high(keymap.of([
      { key: "Mod-s", run: () => { setTimeout(saveEdit); return true; } },
      { key: "Tab", run: (view) => { view.dispatch(view.state.replaceSelection(unit)); return true; } },
    ])),
    keymap.of([...defaultKeymap, ...historyKeymap]),
  ];
}

const targetView = new EditorView({
  parent: $("#target"),
  state: EditorState.create({
    doc: "",
    extensions: [
      tGutterComp.of(lineNumberExt()),
      highlightSpecialChars(),
      tEditComp.of(readOnlyExt),
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

/** Cursor position as {line, col}, both 0-based, for the comparison. */
function cursorOf(state) {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number - 1, col: head - line.from };
}

function onTypedChange() {
  if (app.endTime) return;
  if (!app.startTime && typedView.state.doc.length > 0) {
    app.startTime = performance.now();
    startTimer();
  }
  const state = typedView.state;
  const cmp = compare(typedLinesOf(state), app.targetLines, cursorOf(state));
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
  const head = state.selection.main.head;
  const curLine = doc.lineAt(head);
  const curIdx = curLine.number - 1;
  const curCol = head - curLine.from;
  const cmp = compare(typedLines, app.targetLines, { line: curIdx, col: curCol });

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
    // Ghost text: the rest of the target line, shown at the cursor when
    // everything typed so far is correct. Anything the editor auto-closed to
    // the right of the cursor is trimmed off the end so it isn't shown twice.
    if (settings.ghost && !settings.blind && i === curIdx && !app.endTime &&
        (info.status === "partial" || info.status === "empty")) {
      const t = app.targetLines[i];
      const tail = typedLines[i].slice(curCol);
      if (t !== undefined && AUTO_TAIL.test(tail)) {
        let rest = t.slice(info.tcol || 0);
        if (tail && rest.endsWith(tail)) rest = rest.slice(0, rest.length - tail.length);
        if (rest) b.add(head, head, Decoration.widget({ widget: new GhostWidget(rest), side: 1 }));
      }
    }
  }
  typedView.dispatch({ effects: setTypedDecos.of(b.finish()) });

  if (app.editing) { updateStats(cmp); return; }

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
  if (app.editing) stopEditing();
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
  updateEditButtons();

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
      completeComp.reconfigure(completionExt()),
      bracketComp.reconfigure(settings.brackets ? closeBrackets() : []),
      gutterComp.reconfigure(lineNumberExt()),
    ],
  });
  typedView.scrollDOM.scrollTop = 0;
  // Leave vim in normal mode on a fresh start so `i`, `o`, etc. work as expected.
  refreshDecorations();
  updateStats();
  typedView.focus();
}

// ---------------------------------------------------------------------------
// Editing the reference

function updateEditButtons() {
  const editing = !!app.editing;
  $("#edit-ref").hidden = editing;
  $("#save-ref").hidden = $("#cancel-ref").hidden = !editing;
  $("#revert-ref").hidden = editing || !app.snippet?.repo || app.snippet.code === app.snippet.original;
  document.body.classList.toggle("editing", editing);
  $("#ref-title").textContent = editing ? "Editing reference" : "Reference";
  $("#edit-hint").hidden = !editing;
  $("#edit-hint").textContent = settings.vim ? "Esc → normal mode · :w save · :q cancel" : "Ctrl+S save";
}

function startEditing() {
  if (app.editing) return;
  app.editing = true;
  stopTimer();
  targetView.dispatch({
    effects: [tEditComp.reconfigure(targetEditExt()), setTargetDecos.of(Decoration.none)],
  });
  updateEditButtons();
  targetView.focus();
  // Start in insert mode so you can just type; Esc gets you vim's normal mode.
  const cm = settings.vim && getCM(targetView);
  if (cm) Vim.handleKey(cm, "i", "user");
}

function stopEditing() {
  app.editing = false;
  targetView.dispatch({ effects: tEditComp.reconfigure(readOnlyExt) });
  updateEditButtons();
}

function cancelEdit() {
  if (!app.editing) return;
  stopEditing();
  targetView.dispatch({ changes: { from: 0, to: targetView.state.doc.length, insert: app.targetText } });
  if (app.startTime && !app.endTime) startTimer();
  refreshDecorations();
  typedView.focus();
}

/** Write the edited lines back into the snippet, replacing just the practised range. */
function saveEdit() {
  if (!app.editing) return;
  const snip = app.snippet;
  const edited = targetView.state.doc.toString().replace(/\r\n?/g, "\n");
  const all = snip.code.replace(/\r\n?/g, "\n").split("\n");
  const from = app.rangeStart;
  const to = from + app.targetLines.length - 1;
  const newLines = edited === "" ? [] : edited.split("\n");
  const code = [...all.slice(0, from - 1), ...newLines, ...all.slice(to)].join("\n");
  if (!code.trim()) {
    alert("The snippet can't be empty. Use Delete to remove it instead.");
    return;
  }
  snip.code = code;
  if (snip.repo) store.set("override:" + snip.id, code === snip.original ? null : code);
  else saveUserSnippets();
  stopEditing();
  $("#range-to").value = Math.max(from, from + newLines.length - 1);
  loadSnippet(snip.id, { keepRange: true });
}

function revertSnippet() {
  const snip = app.snippet;
  if (!snip.repo || snip.code === snip.original) return;
  if (!confirm(`Throw away your edits to "${snip.name}" and restore the original?`)) return;
  snip.code = snip.original;
  store.set("override:" + snip.id, null);
  loadSnippet(snip.id, { keepRange: true });
}

$("#edit-ref").addEventListener("click", startEditing);
$("#save-ref").addEventListener("click", saveEdit);
$("#cancel-ref").addEventListener("click", cancelEdit);
$("#revert-ref").addEventListener("click", revertSnippet);

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
  $("#opt-complete").checked = settings.autocomplete;
  $("#opt-brackets").checked = settings.brackets;
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
bindSetting("#opt-complete", "autocomplete", () => {
  typedView.dispatch({ effects: completeComp.reconfigure(completionExt()) });
});
bindSetting("#opt-brackets", "brackets", () => {
  typedView.dispatch({ effects: bracketComp.reconfigure(settings.brackets ? closeBrackets() : []) });
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
    else if (e.code === "KeyA") { e.preventDefault(); $("#opt-complete").click(); }
  }
});

// `:restart` (or `:re`) from vim's command line.
Vim.defineEx("restart", "re", () => restart());
// While editing the reference: `:w` saves, `:q` cancels, `:wq` / `:x` save.
// Deferred, because saving removes vim from that editor and vim is still
// finishing the command when these run.
const later = (fn) => () => setTimeout(fn);
Vim.defineEx("write", "w", later(saveEdit));
Vim.defineEx("quit", "q", later(cancelEdit));
Vim.defineEx("wq", "wq", later(saveEdit));
Vim.defineEx("xit", "x", later(saveEdit));

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
window.codetype = { app, typedView, targetView, restart, loadSnippet, startEditing, saveEdit };
