// The app is written in Traditional Chinese. This build step gives every piece of interface
// text its Simplified form as well, so the person can choose either one in the settings:
//
//   "設定"            becomes   __t("設定", "设置")
//   `共 ${n} 個檔案`   becomes   __tt(["共 ", " 个文件"])`共 ${n} 個檔案`
//   <b>匯入</b>        becomes   <b>{__t("匯入", "导入")}</b>
//
// Nothing has to be done when new text is written: it is picked up here. Text that is data
// rather than wording (a name that is stored, or compared with what is stored) is wrapped in
// keep("…") from src/lib/lang.ts and left alone.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import MagicString from "magic-string";
import * as OpenCC from "opencc-js";

const CJK = /[㐀-鿿]/;
const convert = OpenCC.Converter({ from: "twp", to: "cn" });

// Wording the dictionary gets wrong or leaves in its Taiwanese form, as [converted, wanted].
// Applied in order, after the dictionary.
const FIXES = JSON.parse(fs.readFileSync(new URL("./simplified-fixes.json", import.meta.url), "utf8"));

export function toSimplified(text) {
  // "before": a word with two meanings the dictionary cannot tell apart, settled before it runs
  let out = text;
  for (const [from, to, kind] of FIXES) if (kind === "before") out = out.split(from).join(to);
  out = convert(out);
  for (const [from, to, kind] of FIXES) {
    if (kind === "before") continue;
    out = kind === "re" ? out.replace(new RegExp(from, "g"), to) : out.split(from).join(to);
  }
  return out;
}

/** What React makes of the text between two tags: lines trimmed and joined, as JSX defines it. */
function jsxText(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  let lastFull = 0;
  lines.forEach((line, i) => {
    if (/[^ \t]/.test(line)) lastFull = i;
  });
  let out = "";
  lines.forEach((line, i) => {
    let s = line.replace(/\t/g, " ");
    if (i !== 0) s = s.replace(/^ +/, "");
    if (i !== lines.length - 1) s = s.replace(/ +$/, "");
    if (!s) return;
    out += i === lastFull ? s : s + " ";
  });
  return out;
}

/** @returns {{ code: string, map: unknown, found: { line: number, tw: string, cn: string, kept?: string }[] } | null} */
export function withSimplified(code, id) {
  if (!CJK.test(code)) return null;
  const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, id.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = new MagicString(code);
  const found = [];
  const note = (node, tw, cn, kept) => found.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, tw, cn, ...(kept ? { kept } : {}) });
  const q = JSON.stringify;

  const visit = (node) => {
    if (ts.isTypeNode(node)) return; // "a" | "b" in a type is not text anyone reads
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const tw = node.text;
      if (!CJK.test(tw)) return;
      const cn = toSimplified(tw);
      const parent = node.parent;
      if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === "keep") return note(node, tw, tw, "keep()");
      if (ts.isTaggedTemplateExpression(parent)) return note(node, tw, tw, "tagged");
      if ((ts.isPropertyAssignment(parent) || ts.isEnumMember(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return note(node, tw, tw, "key");
      note(node, tw, cn);
      if (cn === tw) return;
      const start = node.getStart(source);
      const original = code.slice(start, node.end);
      if (ts.isJsxAttribute(parent)) out.overwrite(start, node.end, `{__t(${q(tw)}, ${q(cn)})}`);
      else out.overwrite(start, node.end, `__t(${original}, ${q(cn)})`);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
      if (parts.some((p) => CJK.test(p))) {
        const cn = parts.map(toSimplified);
        const tagged = ts.isTaggedTemplateExpression(node.parent);
        note(node, parts.join("${…}"), cn.join("${…}"), tagged ? "tagged" : undefined);
        if (!tagged && cn.some((c, i) => c !== parts[i])) out.appendLeft(node.getStart(source), `__tt(${q(cn)})`);
      }
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    if (ts.isJsxText(node)) {
      const raw = code.slice(node.pos, node.end);
      if (!CJK.test(raw)) return;
      if (/&(#\w+|\w+);/.test(raw)) throw new Error(`${id}: an entity in the text ${q(raw.trim().slice(0, 40))} — write it as {"…"} instead`);
      const tw = jsxText(raw);
      const cn = toSimplified(tw);
      note(node, tw, cn);
      if (cn !== tw) out.overwrite(node.pos, node.end, `{__t(${q(tw)}, ${q(cn)})}`);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (!out.hasChanged()) return { code, map: null, found };
  out.prepend(`import { __t, __tt } from "slate:lang";\n`);
  return { code: out.toString(), map: out.generateMap({ hires: true, source: id }), found };
}

const RUNTIME = path.resolve("src/lib/lang.ts");
const ours = (id) => /[\\/]src[\\/].*\.tsx?$/.test(id) && !/\.test\.tsx?$/.test(id) && path.resolve(id) !== RUNTIME;

/** The Vite plugin. */
export function simplified() {
  return {
    name: "slate-simplified",
    enforce: "pre",
    resolveId(id) {
      return id === "slate:lang" ? RUNTIME : null;
    },
    transform(code, id) {
      const file = id.split("?")[0];
      if (!ours(file)) return null;
      const done = withSimplified(code, file);
      return done && done.map ? { code: done.code, map: done.map } : null;
    },
  };
}

// node scripts/simplified.mjs  — prints every piece of text and what it becomes, to read through
if (process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase()) {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const file of walk(path.resolve("src")).filter(ours).sort().map((f) => path.relative(".", f))) {
    const done = withSimplified(fs.readFileSync(file, "utf8"), file);
    for (const f of done?.found ?? []) {
      if (process.argv.includes("--changed") && f.cn === f.tw && !f.kept) continue;
      console.log(`${file.replace(/\\/g, "/")}:${f.line}\t${f.kept ? "[" + f.kept + "] " : ""}${f.tw.replace(/\n/g, "⏎")}${f.kept ? "" : "\n\t→ " + f.cn.replace(/\n/g, "⏎")}`);
    }
  }
}
