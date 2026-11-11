import { describe, expect, it } from "vitest";
import { evalFormula } from "./formula";
import { calculate, cellValue, linkedPageIds, outlineOf, sortBetween, applyView } from "./logic";
import type { Page, Property } from "../types";

const props: Record<string, number | string | boolean> = { 單價: 120, 數量: 3, 名字: "筆", 到期: "2026-11-20", 完成: true };
const run = (src: string) => evalFormula(src, (n) => props[n] ?? "");

describe("evalFormula", () => {
  it("does arithmetic with precedence", () => {
    expect(run("1 + 2 * 3")).toEqual({ ok: true, value: 7 });
    expect(run("(1 + 2) * 3")).toEqual({ ok: true, value: 9 });
    expect(run("-2 * 3 % 4")).toEqual({ ok: true, value: -2 });
  });
  it("reads properties", () => {
    expect(run('prop("單價") * prop("數量")')).toEqual({ ok: true, value: 360 });
    expect(run('prop("名字") + " x" + prop("數量")')).toEqual({ ok: true, value: "筆 x3" });
  });
  it("supports if, comparison and logic", () => {
    expect(run('if(prop("數量") >= 3 and prop("完成"), "夠", "不夠")')).toEqual({ ok: true, value: "夠" });
    expect(run('if(not prop("完成") || 1 > 2, 1, 2)')).toEqual({ ok: true, value: 2 });
    expect(run('"a" == "a"')).toEqual({ ok: true, value: true });
  });
  it("has helper functions", () => {
    expect(run("round(10 / 3, 2)")).toEqual({ ok: true, value: 3.33 });
    expect(run('dateBetween(prop("到期"), "2026-11-11")')).toEqual({ ok: true, value: 9 });
    expect(run('dateAdd("2026-11-11", 1, "month")')).toEqual({ ok: true, value: "2026-12-11" });
    expect(run('length(prop("名字")) + max(1, 5, 3)')).toEqual({ ok: true, value: 6 });
  });
  it("lets if() guard a division by zero", () => {
    expect(run("if(0 == 0, 0, 5 / 0)")).toEqual({ ok: true, value: 0 });
    expect(run("5 / 0").ok).toBe(false);
  });
  it("reports errors instead of throwing", () => {
    expect(run("1 +").ok).toBe(false);
    expect(run("單價 * 2").ok).toBe(false);
    expect(run('nope(1)').ok).toBe(false);
    expect(run('"abc').ok).toBe(false);
    expect(run("")).toEqual({ ok: true, value: "" });
  });
});

const schema: Property[] = [
  { id: "p", name: "單價", type: "number" },
  { id: "q", name: "數量", type: "number" },
  { id: "t", name: "小計", type: "formula", formula: 'prop("單價") * prop("數量")' },
  { id: "c1", name: "甲", type: "formula", formula: 'prop("乙")' },
  { id: "c2", name: "乙", type: "formula", formula: 'prop("甲")' },
  { id: "r", name: "關聯", type: "relation", relationDb: "other" },
];
const row = (title: string, p: Page["props"], sort = 0): Page => ({
  id: title, parentId: "db", kind: "page", isRow: true, title, props: p, sort, createdAt: 0, updatedAt: 0,
});
const rows = [row("A", { p: 10, q: 2, r: ["x"] }, 0), row("B", { p: 5, q: 10 }, 1), row("C", {}, 2)];

describe("computed cells", () => {
  it("evaluates formulas per row and sorts by them", () => {
    expect(cellValue(rows[0], "t", schema)).toBe(20);
    const sorted = applyView(rows, { filters: [], sorts: [{ propId: "t", dir: "desc" }] }, schema);
    expect(sorted.map((r) => r.title)).toEqual(["B", "A", "C"]);
  });
  it("filters on formula results numerically", () => {
    const out = applyView(rows, { filters: [{ id: "f", propId: "t", op: "gt", value: "30" }], sorts: [] }, schema);
    expect(out.map((r) => r.title)).toEqual(["B"]);
  });
  it("stops cyclic formulas", () => {
    expect(String(cellValue(rows[0], "c1", schema))).toMatch(/^#/);
  });
  it("searches relation titles", () => {
    const titles = new Map([["x", "客戶甲"]]);
    const out = applyView(rows, { filters: [], sorts: [] }, schema, titles, "客戶");
    expect(out.map((r) => r.title)).toEqual(["A"]);
  });
  it("calculates footers", () => {
    expect(calculate(rows, "p", "sum", schema)).toBe("15");
    expect(calculate(rows, "p", "avg", schema)).toBe("7.5");
    expect(calculate(rows, "p", "filled", schema)).toBe("2");
    expect(calculate(rows, "p", "count", schema)).toBe("3");
    expect(calculate(rows, "t", "max", schema)).toBe("50");
  });
});

describe("document helpers", () => {
  const doc = [
    { id: "h1", type: "heading", props: { level: 1 }, content: [{ type: "text", text: "第一章" }], children: [] },
    { id: "p1", type: "paragraph", content: [
      { type: "text", text: "見 " },
      { type: "mention", props: { pageId: "pg2" } },
    ], children: [
      { id: "h2", type: "heading", props: { level: 2 }, content: [{ type: "text", text: "小節" }], children: [] },
    ] },
    { id: "l1", type: "pageLink", props: { pageId: "pg1" }, children: [] },
  ];
  it("extracts the outline including nested headings", () => {
    expect(outlineOf(doc)).toEqual([
      { id: "h1", level: 1, text: "第一章" },
      { id: "h2", level: 2, text: "小節" },
    ]);
  });
  it("finds linked pages from blocks and mentions", () => {
    expect(linkedPageIds(doc).sort()).toEqual(["pg1", "pg2"]);
  });
  it("computes sort keys between neighbours", () => {
    expect(sortBetween(1, 2)).toBe(1.5);
    expect(sortBetween(undefined, 2)).toBe(1);
    expect(sortBetween(3, undefined)).toBe(4);
  });
});

import { guessType, parseCsv, quadrant } from "./logic";

describe("rollup", () => {
  const orders: Property[] = [
    { id: "rel", name: "品項", type: "relation", relationDb: "items" },
    { id: "total", name: "總價", type: "rollup", rollupRel: "rel", rollupProp: "price", rollupCalc: "sum" },
    { id: "names", name: "品名", type: "rollup", rollupRel: "rel", rollupProp: "title", rollupCalc: "show" },
    { id: "n", name: "數", type: "rollup", rollupRel: "rel", rollupCalc: "count" },
    { id: "f", name: "含稅", type: "formula", formula: 'round(prop("總價") * 1.05)' },
  ];
  const items: Property[] = [{ id: "price", name: "價格", type: "number" }];
  const a = { ...row("筆", { price: 30 }), id: "a" };
  const b = { ...row("紙", { price: 70 }), id: "b" };
  const titles = Object.assign(new Map([["a", "筆"], ["b", "紙"]]), {
    rows: new Map([["a", a], ["b", b]]),
    schemas: new Map([["items", items]]),
  });
  const order = row("訂單", { rel: ["a", "b", "missing"] });
  it("combines values from related rows", () => {
    expect(cellValue(order, "total", orders, titles)).toBe(100);
    expect(cellValue(order, "names", orders, titles)).toBe("筆, 紙");
    expect(cellValue(order, "n", orders, titles)).toBe(2);
  });
  it("can feed a formula", () => {
    expect(cellValue(order, "f", orders, titles)).toBe(105);
  });
  it("is empty without related data", () => {
    expect(cellValue(order, "total", orders)).toBe("");
  });
});

describe("parseCsv", () => {
  it("handles quotes, commas, newlines and BOM", () => {
    expect(parseCsv('\uFEFF名稱,備註\r\n"a,b","他說 ""好"""\n"多\n行",x\n\n')).toEqual([
      ["名稱", "備註"],
      ["a,b", '他說 "好"'],
      ["多\n行", "x"],
    ]);
  });
  it("guesses column types", () => {
    expect(guessType(["1", "2.5", ""])).toBe("number");
    expect(guessType(["2026-01-02", "2026/3/4"])).toBe("date");
    expect(guessType(["https://a.tw"])).toBe("url");
    expect(guessType(["進行中", "完成", "進行中", "完成", "進行中", "完成"])).toBe("select");
    expect(guessType(["甲", "乙", "丙"])).toBe("text");
  });
});

describe("quadrant", () => {
  it("sorts tasks by importance and urgency", () => {
    expect(quadrant({ priority: 3, due: "2026-11-11" }, "2026-11-11")).toBe(1);
    expect(quadrant({ priority: 2, due: "2026-11-20" }, "2026-11-11")).toBe(2);
    expect(quadrant({ priority: 0, due: "2026-11-10" }, "2026-11-11")).toBe(3);
    expect(quadrant({ priority: 1, due: null }, "2026-11-11")).toBe(4);
  });
});
