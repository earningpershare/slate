import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db";
import { callTool, slateTools, validate } from "./tools";

/** stand-ins for the editor's Markdown conversion: one paragraph per line */
const written: string[] = [];
const tools = slateTools({
  toBlocks: (md) => md.split("\n").filter((l) => l.trim()).map((l) => ({ type: "paragraph", content: [{ type: "text", text: l, styles: {} }] })),
  toMarkdown: (blocks) => (blocks as { content: { text: string }[] }[]).map((b) => b.content.map((c) => c.text).join("")).join("\n"),
  pageWritten: (id) => written.push(id),
});
const call = async (name: string, input: unknown) => {
  const r = await callTool(tools, name, input);
  return { ...r, data: r.error ? null : JSON.parse(r.text) };
};

beforeEach(async () => {
  await Promise.all([db.pages.clear(), db.tasks.clear(), db.lists.clear(), db.history.clear()]);
  written.length = 0;
});

describe("tool definitions", () => {
  it("are well-formed and safe to hand to any model", () => {
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z_]{3,40}$/);
      expect(t.description.length).toBeGreaterThan(30);
      expect(t.schema.additionalProperties).toBe(false);
      for (const r of t.schema.required) expect(t.schema.properties[r]).toBeTruthy();
    }
    // everything that destroys data asks first
    expect(tools.filter((t) => t.danger).map((t) => t.name).sort()).toEqual(["delete_task", "trash_page"]);
  });

  it("input is checked before a tool runs", async () => {
    const add = tools.find((t) => t.name === "add_task")!;
    expect(validate(add, { title: "x" })).toEqual([]);
    expect(validate(add, {})).toEqual(['missing "title"']);
    expect(validate(add, { title: 1, priority: 9, nope: true })).toEqual(['"title" must be a string', '"priority" must be one of 0, 1, 2, 3', 'unknown field "nope"']);
    expect(await call("add_task", { title: "x", due: "tomorrow" })).toMatchObject({ error: true, text: "due must be YYYY-MM-DD" });
    expect(await call("no_such_tool", {})).toMatchObject({ error: true });
    expect(await db.tasks.count()).toBe(0);
  });
});

describe("pages", () => {
  it("create, find, read, rewrite and append", async () => {
    const trip = (await call("create_page", { title: "旅行計畫", markdown: "訂機票\n訂飯店", icon: "✈️" })).data;
    const sub = (await call("create_page", { title: "行李清單", markdown: "護照", parent_id: trip.id })).data;
    expect((await db.pages.get(sub.id))!.parentId).toBe(trip.id);

    const found = (await call("search", { query: "飯店" })).data;
    expect(found.pages).toEqual([expect.objectContaining({ id: trip.id, title: "旅行計畫", kind: "page" })]);
    expect(found.pages[0].excerpt).toContain("訂飯店");
    expect((await call("search", { query: "護照" })).data.pages[0]).toMatchObject({ id: sub.id, inside: "旅行計畫" });

    expect((await call("list_pages", {})).data).toEqual([{ id: trip.id, kind: "page", title: "旅行計畫", children: 1 }]);
    expect((await call("read_page", { id: trip.id })).data).toMatchObject({ title: "旅行計畫", content: "訂機票\n訂飯店" });

    await call("update_page", { id: trip.id, markdown: "買保險", mode: "append" });
    expect((await call("read_page", { id: trip.id })).data.content).toBe("訂機票\n訂飯店\n買保險");
    await call("update_page", { id: trip.id, title: "日本旅行", markdown: "全部重寫" });
    expect((await call("read_page", { id: trip.id })).data).toMatchObject({ title: "日本旅行", content: "全部重寫" });
    // what was there before can be brought back from the page's history, and an open editor is told to reload
    expect((await db.history.where("pageId").equals(trip.id).count()) > 0).toBe(true);
    expect(written).toContain(trip.id);
  });

  it("a trashed page is gone for the tools, and a locked page is not rewritten", async () => {
    const p = (await call("create_page", { title: "舊筆記", markdown: "內容" })).data;
    await db.pages.update(p.id, { locked: true });
    expect(await call("update_page", { id: p.id, markdown: "改掉" })).toMatchObject({ error: true });
    expect((await call("read_page", { id: p.id })).data.content).toBe("內容");
    expect((await call("trash_page", { id: p.id })).data).toMatchObject({ trashed: true });
    expect(await call("read_page", { id: p.id })).toMatchObject({ error: true });
    expect((await call("search", { query: "舊筆記" })).data.pages).toEqual([]);
    expect(await db.pages.get(p.id)).toBeTruthy(); // in the trash, not destroyed
  });
});

describe("databases", () => {
  it("create with columns, add and change rows by column name", async () => {
    const d = (
      await call("create_database", {
        title: "記帳",
        columns: [
          { name: "金額", type: "number" },
          { name: "類別", type: "select", options: ["餐飲", "交通"] },
          { name: "日期", type: "date" },
          { name: "已報帳", type: "checkbox" },
        ],
      })
    ).data;
    const lunch = (await call("add_row", { database_id: d.id, title: "午餐", values: { 金額: 120, 類別: "餐飲", 日期: "2025-03-01" } })).data;
    // a select value nobody defined yet becomes a new option
    await call("add_row", { database_id: d.id, title: "電影", values: { 金額: "320", 類別: "娛樂" } });

    const read = (await call("read_page", { id: d.id })).data;
    expect(read.columns.find((c: { name: string }) => c.name === "類別").options).toEqual(["餐飲", "交通", "娛樂"]);
    expect(read.rows).toEqual([
      { id: lunch.id, title: "午餐", 金額: 120, 類別: "餐飲", 日期: "2025-03-01" },
      expect.objectContaining({ title: "電影", 金額: 320, 類別: "娛樂" }),
    ]);

    expect((await call("update_row", { id: lunch.id, values: { 已報帳: true, 金額: 150, 日期: null } })).data).toEqual({ id: lunch.id, title: "午餐", 金額: 150, 類別: "餐飲", 已報帳: true });
    expect(await call("update_row", { id: lunch.id, values: { 不存在: 1 } })).toMatchObject({ error: true });
    expect((await call("update_row", { id: lunch.id, values: { 日期: "三月一日" } })).text).toContain("YYYY-MM-DD");
  });
});

describe("tasks", () => {
  it("add, list by list and date, change and finish", async () => {
    const a = (await call("add_task", { title: "交報告", list: "工作", due: "2025-03-05", due_time: "09:30", priority: 3, tags: ["急"] })).data;
    await call("add_task", { title: "買牛奶", due: "2025-03-08" });
    await call("add_task", { title: "沒有日期" });
    expect((await db.lists.toArray()).map((l) => l.name)).toEqual(["工作"]); // created on the way

    const all = (await call("list_tasks", {})).data;
    expect(all.lists).toEqual(["收件匣", "工作"]);
    expect(all.tasks.map((t: { title: string }) => t.title)).toEqual(["交報告", "買牛奶", "沒有日期"]);
    expect(all.tasks[0]).toEqual({ id: a.id, title: "交報告", list: "工作", done: false, due: "2025-03-05", due_time: "09:30", priority: 3, tags: ["急"] });

    expect((await call("list_tasks", { list: "收件匣" })).data.tasks).toHaveLength(2);
    expect((await call("list_tasks", { due_to: "2025-03-06" })).data.tasks.map((t: { title: string }) => t.title)).toEqual(["交報告"]);
    expect(await call("list_tasks", { list: "不存在" })).toMatchObject({ error: true });

    const moved = (await call("update_task", { id: a.id, due: "2025-03-10", due_time: "", list: "收件匣", done: true })).data;
    expect(moved).toMatchObject({ list: "收件匣", due: "2025-03-10", done: true });
    expect(moved.due_time).toBeUndefined();
    expect((await db.tasks.get(a.id))!.completedAt).toBeGreaterThan(0);
    expect((await call("list_tasks", {})).data.tasks).toHaveLength(2);
    expect((await call("list_tasks", { status: "done" })).data.tasks).toHaveLength(1);

    expect((await call("delete_task", { id: a.id })).data).toMatchObject({ deleted: true });
    expect(await call("update_task", { id: a.id, done: false })).toMatchObject({ error: true });
  });
});
