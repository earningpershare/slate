// Pure logic (no DB / DOM) so it can be unit-tested.
import dayjs from "dayjs";
import type { Calc, Filter, Page, Property, PropValue, Repeat, Sort, Task } from "../types";
import { evalFormula, type FValue } from "./formula";

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

export const today = () => dayjs().format("YYYY-MM-DD");

/** Next due date for a repeating task, counted from its current due date. */
export function nextDue(due: string, repeat: Repeat): string {
  const d = dayjs(due);
  switch (repeat) {
    case "daily":
      return d.add(1, "day").format("YYYY-MM-DD");
    case "weekdays": {
      let n = d.add(1, "day");
      while (n.day() === 0 || n.day() === 6) n = n.add(1, "day");
      return n.format("YYYY-MM-DD");
    }
    case "weekly":
      return d.add(1, "week").format("YYYY-MM-DD");
    case "monthly":
      return d.add(1, "month").format("YYYY-MM-DD");
    case "yearly":
      return d.add(1, "year").format("YYYY-MM-DD");
  }
}

/**
 * Titles of related rows, keyed by row id (for relation properties). Rollups
 * additionally need the related rows themselves and the schema of their database.
 */
export type Titles = Map<string, string> & {
  rows?: Map<string, Page>;
  schemas?: Map<string, Property[]>;
};

export const COMPUTED: Property["type"][] = ["formula", "rollup", "createdTime", "updatedTime"];

const isEmpty = (v: PropValue) =>
  v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** Human-readable text of a value (select ids / relation ids resolved to names). */
export function displayValue(v: PropValue, prop?: Property, titles?: Titles): string {
  if (isEmpty(v)) return "";
  if (prop?.type === "relation") {
    return (Array.isArray(v) ? v : [String(v)]).map((id) => titles?.get(id) ?? "").filter(Boolean).join(", ");
  }
  if (prop?.options) {
    const name = (id: string) => prop.options!.find((o) => o.id === id)?.name ?? "";
    return Array.isArray(v) ? v.map(name).join(", ") : name(String(v));
  }
  if (typeof v === "boolean") return v ? "✓" : "";
  return Array.isArray(v) ? v.join(", ") : String(v);
}

/**
 * The value of a cell, including computed properties (formula, timestamps).
 * `depth` guards against formulas that reference each other in a cycle.
 */
export function cellValue(
  row: Page,
  propId: string,
  schema: Property[],
  titles?: Titles,
  depth = 0,
): PropValue {
  if (propId === "title") return row.title;
  const prop = schema.find((p) => p.id === propId);
  if (!prop) return row.props?.[propId];
  switch (prop.type) {
    case "createdTime":
      return dayjs(row.createdAt).format("YYYY-MM-DD HH:mm");
    case "updatedTime":
      return dayjs(row.updatedAt).format("YYYY-MM-DD HH:mm");
    case "rollup": {
      if (depth > 8) return "#循環參照";
      const rel = schema.find((p) => p.id === prop.rollupRel && p.type === "relation");
      if (!rel || !titles?.rows) return "";
      const ids = row.props?.[rel.id];
      const targets = (Array.isArray(ids) ? ids : [])
        .map((id) => titles.rows!.get(id))
        .filter((r): r is Page => !!r);
      const tSchema = titles.schemas?.get(rel.relationDb ?? "") ?? [];
      const tProp = tSchema.find((p) => p.id === prop.rollupProp);
      const calc = prop.rollupCalc ?? "show";
      if (calc === "count") return targets.length;
      const values = targets.map((t) => cellValue(t, prop.rollupProp || "title", tSchema, titles, depth + 1));
      const filled = values.filter((v) => !isEmpty(v) && v !== false);
      if (calc === "filled") return filled.length;
      if (calc === "show") {
        return filled
          .map((v) => displayValue(v, tProp, titles))
          .filter(Boolean)
          .join(", ");
      }
      const nums = filled.map(Number).filter((n) => Number.isFinite(n));
      if (nums.length === 0) return "";
      const sum = nums.reduce((a, b) => a + b, 0);
      const out =
        calc === "sum" ? sum : calc === "avg" ? sum / nums.length : calc === "min" ? Math.min(...nums) : Math.max(...nums);
      return Math.round(out * 100) / 100;
    }
    case "formula": {
      if (depth > 8) return "#循環參照";
      const get = (name: string): FValue => {
        if (name === "名稱" || name === "title") return row.title;
        const p = schema.find((x) => x.name === name);
        if (!p) throw new Error(`找不到屬性「${name}」`);
        const v = cellValue(row, p.id, schema, titles, depth + 1);
        if (typeof v === "number" || typeof v === "boolean") return v;
        return displayValue(v, p, titles);
      };
      const r = evalFormula(prop.formula ?? "", get);
      if (!r.ok) return "#" + r.error;
      return typeof r.value === "boolean" ? (r.value ? "✓" : "✗") : r.value;
    }
    default:
      return row.props?.[propId];
  }
}

/** Kept for callers that only need stored values. */
export function getProp(row: Page, propId: string): PropValue {
  return propId === "title" ? row.title : row.props?.[propId];
}

export function matchFilter(row: Page, f: Filter, schema: Property[], titles?: Titles): boolean {
  const prop = schema.find((p) => p.id === f.propId);
  const raw = cellValue(row, f.propId, schema, titles);
  const target = (f.value ?? "").trim();
  switch (f.op) {
    case "empty":
      return isEmpty(raw);
    case "notEmpty":
      return !isEmpty(raw);
    case "checked":
      return raw === true;
    case "unchecked":
      return raw !== true;
  }
  // An unfinished filter (no value typed yet) should not hide everything.
  if (target === "") return true;
  const text = displayValue(raw, prop, titles).toLowerCase();
  const t = target.toLowerCase();
  const numeric = prop?.type === "number" || (typeof raw === "number" && Number.isFinite(Number(target)));
  switch (f.op) {
    case "contains":
      return text.includes(t);
    case "notContains":
      return !text.includes(t);
    case "eq":
      return numeric ? Number(raw) === Number(target) : text === t;
    case "neq":
      return numeric ? Number(raw) !== Number(target) : text !== t;
    case "gt":
    case "lt": {
      if (isEmpty(raw)) return false;
      const cmp = numeric ? Number(raw) - Number(target) : String(raw).localeCompare(target);
      return f.op === "gt" ? cmp > 0 : cmp < 0;
    }
  }
  return true;
}

export function compareRows(a: Page, b: Page, sorts: Sort[], schema: Property[], titles?: Titles): number {
  for (const s of sorts) {
    const prop = schema.find((p) => p.id === s.propId);
    const va = cellValue(a, s.propId, schema, titles);
    const vb = cellValue(b, s.propId, schema, titles);
    const ea = isEmpty(va);
    const eb = isEmpty(vb);
    if (ea && eb) continue;
    // empty values always sink to the bottom, regardless of direction
    if (ea) return 1;
    if (eb) return -1;
    let c: number;
    if (typeof va === "number" && typeof vb === "number") c = va - vb;
    else if (prop?.type === "checkbox") c = Number(va === true) - Number(vb === true);
    else
      c = displayValue(va, prop, titles).localeCompare(displayValue(vb, prop, titles), "zh-Hant", {
        numeric: true,
      });
    if (c !== 0) return s.dir === "asc" ? c : -c;
  }
  return a.sort - b.sort;
}

export function applyView(
  rows: Page[],
  view: { filters: Filter[]; sorts: Sort[] },
  schema: Property[],
  titles?: Titles,
  search = "",
): Page[] {
  const term = search.trim().toLowerCase();
  return rows
    .filter((r) => view.filters.every((f) => matchFilter(r, f, schema, titles)))
    .filter(
      (r) =>
        !term ||
        r.title.toLowerCase().includes(term) ||
        schema.some((p) =>
          displayValue(cellValue(r, p.id, schema, titles), p, titles).toLowerCase().includes(term),
        ),
    )
    .sort((a, b) => compareRows(a, b, view.sorts, schema, titles));
}

/** Footer calculation for one column. Returns "" when there is nothing to show. */
export function calculate(
  rows: Page[],
  propId: string,
  calc: Calc,
  schema: Property[],
  titles?: Titles,
): string {
  const values = rows.map((r) => cellValue(r, propId, schema, titles));
  if (calc === "count") return String(rows.length);
  const filled = values.filter((v) => !isEmpty(v) && v !== false);
  if (calc === "filled") return String(filled.length);
  const nums = filled.map(Number).filter((n) => Number.isFinite(n));
  if (nums.length === 0) return "";
  const round = (n: number) => String(Math.round(n * 100) / 100);
  switch (calc) {
    case "sum":
      return round(nums.reduce((a, b) => a + b, 0));
    case "avg":
      return round(nums.reduce((a, b) => a + b, 0) / nums.length);
    case "min":
      return round(Math.min(...nums));
    case "max":
      return round(Math.max(...nums));
  }
}

/** A sort key that places an item between two neighbours (either may be absent). */
export function sortBetween(before?: number, after?: number): number {
  if (before === undefined && after === undefined) return 1;
  if (before === undefined) return after! - 1;
  if (after === undefined) return before + 1;
  return (before + after) / 2;
}

/**
 * Quick-add parsing, e.g. "明天 交報告 !3 #工作".
 * Recognises 今天/明天/後天, !1..!3 priority and #tags.
 */
export function parseQuickAdd(
  input: string,
  base = today(),
): Pick<Task, "title" | "due" | "priority" | "tags"> {
  let due: string | null = null;
  let priority: Task["priority"] = 0;
  const tags: string[] = [];
  const words: string[] = [];
  const offsets: Record<string, number> = { 今天: 0, 明天: 1, 後天: 2, 后天: 2 };
  for (const w of input.trim().split(/\s+/)) {
    if (w in offsets && due === null) due = dayjs(base).add(offsets[w], "day").format("YYYY-MM-DD");
    else if (/^[!！][1-3]$/.test(w)) priority = Number(w[1]) as Task["priority"];
    else if (/^#.+/.test(w)) tags.push(w.slice(1));
    else if (w) words.push(w);
  }
  return { title: words.join(" "), due, priority, tags };
}

/** Flatten BlockNote JSON to plain text for search. */
export function blocksToText(blocks: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n === "object") {
      const o = n as Record<string, unknown>;
      if (typeof o.text === "string") out.push(o.text);
      walk(o.content);
      walk(o.children);
      walk(o.rows);
      walk(o.cells);
    }
  };
  walk(blocks);
  return out.join(" ");
}

/** Ids of pages referenced from a document (sub-page links, inline databases, @mentions). */
export function linkedPageIds(blocks: unknown): string[] {
  const out = new Set<string>();
  const walk = (n: unknown) => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n === "object") {
      const o = n as Record<string, unknown>;
      const props = o.props as Record<string, unknown> | undefined;
      if (typeof props?.pageId === "string" && props.pageId) out.add(props.pageId);
      walk(o.content);
      walk(o.children);
      walk(o.rows);
      walk(o.cells);
    }
  };
  walk(blocks);
  return [...out];
}

/** Headings of a document, for the outline. */
export function outlineOf(blocks: unknown): { id: string; level: number; text: string }[] {
  const out: { id: string; level: number; text: string }[] = [];
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const b of list as Record<string, unknown>[]) {
      if (b?.type === "heading") {
        const text = blocksToText(b.content).trim();
        const level = Number((b.props as Record<string, unknown>)?.level ?? 1);
        if (text) out.push({ id: String(b.id), level, text });
      }
      walk(b?.children);
    }
  };
  walk(blocks);
  return out;
}

/** Current streak of consecutive check-in days ending today (or yesterday). */
export function habitStreak(days: string[], base = today()): number {
  const set = new Set(days);
  let d = dayjs(base);
  if (!set.has(d.format("YYYY-MM-DD"))) d = d.subtract(1, "day");
  let n = 0;
  while (set.has(d.format("YYYY-MM-DD"))) {
    n++;
    d = d.subtract(1, "day");
  }
  return n;
}

/** Convert a stored value when a property's type is changed. */
export function convertValue(v: PropValue, from: Property, to: Property["type"]): PropValue {
  if (isEmpty(v)) return null;
  if (from.type === to) return v;
  if (COMPUTED.includes(to) || to === "relation" || from.type === "relation") return null;
  const isSel = (t: string) => t === "select" || t === "multiSelect";
  if (isSel(from.type) && isSel(to)) {
    return to === "multiSelect" ? [String(v)] : ((v as string[])[0] ?? null);
  }
  const text = displayValue(v, from);
  switch (to) {
    case "text":
    case "url":
      return text;
    case "number": {
      const n = Number(text);
      return text.trim() !== "" && Number.isFinite(n) ? n : null;
    }
    default:
      return null;
  }
}

/** Parse CSV text (quoted fields, escaped quotes, CRLF, embedded newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

/** Guess a property type for a CSV column from its values. */
export function guessType(values: string[]): "number" | "date" | "checkbox" | "url" | "select" | "text" {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  if (filled.length === 0) return "text";
  if (filled.every((v) => /^-?\d+(\.\d+)?$/.test(v))) return "number";
  if (filled.every((v) => /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(v))) return "date";
  if (filled.every((v) => /^(true|false|yes|no|✓|是|否)$/i.test(v))) return "checkbox";
  if (filled.every((v) => /^https?:\/\//i.test(v))) return "url";
  const distinct = new Set(filled);
  if (
    filled.length >= 4 &&
    distinct.size <= Math.max(2, filled.length / 3) &&
    [...distinct].every((v) => v.length <= 20)
  ) {
    return "select";
  }
  return "text";
}

/** Eisenhower quadrant: important = medium/high priority, urgent = due by tomorrow. */
export function quadrant(task: Pick<Task, "priority" | "due">, base = today()): 1 | 2 | 3 | 4 {
  const important = task.priority >= 2;
  const urgent = !!task.due && dayjs(task.due).diff(dayjs(base), "day") <= 1;
  return important ? (urgent ? 1 : 2) : urgent ? 3 : 4;
}

/**
 * Link target for a URL cell, or null when it must not be clickable.
 * Only http(s) and mailto are allowed, so a value such as "javascript:..."
 * (typed, or arriving through an imported CSV / backup) can never run as a link.
 */
export function safeHref(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (/^(https?:\/\/|mailto:)/i.test(v)) return v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null;
  return "https://" + v;
}

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (= + - @ ...)
 * gets a leading apostrophe; plain numbers such as -5 are left alone.
 */
export function csvCell(value: string): string {
  let s = value;
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** MIME types that are safe to hand to the browser as-is from stored files. */
export function safeBlobType(type: string): string {
  const t = type.toLowerCase().split(";")[0].trim();
  const ok =
    /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(t) ||
    /^(audio|video)\/[a-z0-9.+-]+$/.test(t) ||
    t === "application/pdf";
  // anything else (html, svg, scripts...) is served as an opaque download
  return ok ? t : "application/octet-stream";
}
