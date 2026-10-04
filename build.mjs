// Bundles src/main.js -> dist/app.js and embeds every file under snippets/
// so it shows up in the app's snippet list.
import * as esbuild from "esbuild";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function collectSnippets(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries.sort()) {
    if (name.startsWith(".") || name === "README.md") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...collectSnippets(full));
    else if (st.size < 2_000_000) {
      out.push({ path: relative("snippets", full).split("\\").join("/"), code: readFileSync(full, "utf8") });
    }
  }
  return out;
}

const snippets = collectSnippets("snippets");
const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/main.js"],
  bundle: true,
  minify: !watch,
  format: "iife",
  target: "es2020",
  outfile: "dist/app.js",
  define: { __SNIPPETS__: JSON.stringify(snippets) },
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log(`Embedded ${snippets.length} snippet(s) from snippets/`);
}
