import { describe, expect, it } from "vitest";
import {
  applyView,
  blocksToText,
  habitStreak,
  matchFilter,
  nextDue,
  parseQuickAdd,
} from "./logic";
import type { Page, Property } from "../types";

const schema: Property[] = [
  { id: "n", name: "數量", type: "number" },
  {
    id: "s",
    name: "狀態",
    type: "select",
    options: [
      { id: "o1", name: "進行中", color: "blue" },
      { id: "o2", name: "完成", color: "green" },
    ],
  },
  { id: "c", name: "勾選", type: "checkbox" },
];

const row = (title: string, props: Page["props"], sort = 0): Page => ({
  id: title,
  parentId: "db",
  kind: "page",
  isRow: true,
  title,
  props,
  sort,
  createdAt: 0,
  updatedAt: 0,
});

describe("nextDue", () => {
  it("advances by the repeat unit", () => {
    expect(nextDue("2026-11-11", "daily")).toBe("2026-11-12");
    expect(nextDue("2026-11-11", "weekly")).toBe("2026-11-18");
    expect(nextDue("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(nextDue("2024-02-29", "yearly")).toBe("2025-02-28");
  });
  it("skips weekends for weekdays", () => {
    expect(nextDue("2026-11-13", "weekdays")).toBe("2026-11-16"); // Fri -> Mon
    expect(nextDue("2026-11-14", "weekdays")).toBe("2026-11-16"); // Sat -> Mon
  });
});

describe("filters and sorts", () => {
  const rows = [
    row("蘋果", { n: 10, s: "o1", c: true }, 0),
    row("香蕉", { n: 2, s: "o2" }, 1),
    row("櫻桃", {}, 2),
  ];
  it("filters select by option name, not id", () => {
    const f = { id: "f", propId: "s", op: "eq" as const, value: "完成" };
    expect(rows.filter((r) => matchFilter(r, f, schema)).map((r) => r.title)).toEqual(["香蕉"]);
  });
  it("compares numbers numerically", () => {
    const f = { id: "f", propId: "n", op: "gt" as const, value: "9" };
    expect(rows.filter((r) => matchFilter(r, f, schema)).map((r) => r.title)).toEqual(["蘋果"]);
  });
  it("ignores a filter with no value yet", () => {
    const f = { id: "f", propId: "title", op: "contains" as const, value: "" };
    expect(rows.filter((r) => matchFilter(r, f, schema))).toHaveLength(3);
  });
  it("handles empty / checkbox operators", () => {
    expect(rows.filter((r) => matchFilter(r, { id: "f", propId: "n", op: "empty" }, schema)).map((r) => r.title)).toEqual(["櫻桃"]);
    expect(rows.filter((r) => matchFilter(r, { id: "f", propId: "c", op: "unchecked" }, schema)).map((r) => r.title)).toEqual(["香蕉", "櫻桃"]);
  });
  it("sorts with empties last in both directions", () => {
    const asc = applyView(rows, { filters: [], sorts: [{ propId: "n", dir: "asc" }] }, schema);
    const desc = applyView(rows, { filters: [], sorts: [{ propId: "n", dir: "desc" }] }, schema);
    expect(asc.map((r) => r.title)).toEqual(["香蕉", "蘋果", "櫻桃"]);
    expect(desc.map((r) => r.title)).toEqual(["蘋果", "香蕉", "櫻桃"]);
  });
});

describe("parseQuickAdd", () => {
  it("extracts date, priority and tags", () => {
    expect(parseQuickAdd("明天 交報告 !3 #工作", "2026-11-11")).toEqual({
      title: "交報告",
      due: "2026-11-12",
      priority: 3,
      tags: ["工作"],
    });
  });
  it("leaves plain titles alone", () => {
    expect(parseQuickAdd("買牛奶", "2026-11-11")).toEqual({
      title: "買牛奶",
      due: null,
      priority: 0,
      tags: [],
    });
  });
});

describe("blocksToText", () => {
  it("flattens nested blocks", () => {
    const doc = [
      { type: "paragraph", content: [{ type: "text", text: "你好" }], children: [
        { type: "paragraph", content: [{ type: "text", text: "世界" }], children: [] },
      ] },
    ];
    expect(blocksToText(doc)).toBe("你好 世界");
  });
});

describe("habitStreak", () => {
  it("counts consecutive days ending today or yesterday", () => {
    expect(habitStreak(["2026-11-09", "2026-11-10", "2026-11-11"], "2026-11-11")).toBe(3);
    expect(habitStreak(["2026-11-09", "2026-11-10"], "2026-11-11")).toBe(2);
    expect(habitStreak(["2026-11-08"], "2026-11-11")).toBe(0);
  });
});

import { convertValue } from "./logic";

describe("convertValue", () => {
  it("keeps what can be kept when a property changes type", () => {
    expect(convertValue("o1", schema[1], "text")).toBe("進行中");
    expect(convertValue("o1", schema[1], "multiSelect")).toEqual(["o1"]);
    expect(convertValue(["o2", "o1"], { ...schema[1], type: "multiSelect" }, "select")).toBe("o2");
    expect(convertValue("12.5", { id: "t", name: "t", type: "text" }, "number")).toBe(12.5);
    expect(convertValue("abc", { id: "t", name: "t", type: "text" }, "number")).toBeNull();
    expect(convertValue(5, schema[0], "date")).toBeNull();
  });
});
