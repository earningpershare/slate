// Starter content offered on an empty page.
import dayjs from "dayjs";

type B = { type: string; props?: Record<string, unknown>; content?: string };

const h = (content: string, level = 2): B => ({ type: "heading", props: { level }, content });
const p = (content = ""): B => ({ type: "paragraph", content });
const li = (content = ""): B => ({ type: "bulletListItem", content });
const todo = (content = ""): B => ({ type: "checkListItem", content });
const note = (content: string, emoji = "💡"): B => ({ type: "callout", props: { emoji }, content });

export interface Template {
  id: string;
  name: string;
  icon: string;
  title: () => string;
  blocks: () => B[];
}

export const TEMPLATES: Template[] = [
  {
    id: "meeting",
    name: "會議記錄",
    icon: "🗓️",
    title: () => `${dayjs().format("M/D")} 會議記錄`,
    blocks: () => [
      note(`日期：${dayjs().format("YYYY-MM-DD")}　與會者：`, "📌"),
      h("議程"),
      li(),
      h("討論重點"),
      li(),
      h("決議"),
      li(),
      h("待辦事項"),
      todo("負責人／期限："),
    ],
  },
  {
    id: "weekly",
    name: "週計畫",
    icon: "📅",
    title: () => `${dayjs().startOf("week").add(1, "day").format("M/D")} 週計畫`,
    blocks: () => [
      h("本週最重要的三件事"),
      todo(),
      todo(),
      todo(),
      ...["週一", "週二", "週三", "週四", "週五"].flatMap((d) => [h(d, 3), todo()]),
      h("週末回顧"),
      p("做得好的："),
      p("下週要調整的："),
    ],
  },
  {
    id: "project",
    name: "專案簡報",
    icon: "🚀",
    title: () => "專案名稱",
    blocks: () => [
      note("一句話說明這個專案要解決什麼問題。"),
      h("背景"),
      p(),
      h("目標"),
      li("要達成的："),
      li("不做的："),
      h("里程碑"),
      todo("第一階段 —"),
      todo("第二階段 —"),
      h("風險與未決問題"),
      li(),
    ],
  },
  {
    id: "reading",
    name: "讀書筆記",
    icon: "📚",
    title: () => "書名",
    blocks: () => [
      p("作者：　　　讀完日期："),
      h("一句話總結"),
      p(),
      h("重點摘錄"),
      { type: "quote", content: "" },
      h("我的想法"),
      p(),
      h("可以馬上用的"),
      todo(),
    ],
  },
  {
    id: "journal",
    name: "日記",
    icon: "✏️",
    title: () => dayjs().format("YYYY 年 M 月 D 日 dddd"),
    blocks: () => [h("今天發生的事", 3), p(), h("感謝的三件事", 3), li(), li(), li(), h("明天想做的", 3), todo()],
  },
];
