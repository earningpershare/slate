import { useState } from "react";
import dayjs from "dayjs";
import { useLiveQuery } from "dexie-react-hooks";
import { CalendarDays, FilePlus2, NotebookPen, PanelLeftOpen, Plus, Star } from "lucide-react";
import { addTask, createPage, db, openDailyNote, toggleTask } from "../db";
import { parseQuickAdd, today } from "../lib/logic";
import type { Page } from "../types";
import { navigate, openPage } from "../ui";
import { pageIcon } from "./Sidebar";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "夜深了";
  if (h < 11) return "早安";
  if (h < 14) return "午安";
  if (h < 18) return "下午好";
  return "晚安";
}

const ago = (t: number) => {
  const m = dayjs().diff(dayjs(t), "minute");
  if (m < 1) return "剛剛";
  if (m < 60) return `${m} 分鐘前`;
  if (m < 60 * 24) return `${Math.floor(m / 60)} 小時前`;
  if (m < 60 * 24 * 7) return `${Math.floor(m / 60 / 24)} 天前`;
  return dayjs(t).format("M/D");
};

export default function Home({
  sidebarHidden,
  onShowSidebar,
}: {
  sidebarHidden: boolean;
  onShowSidebar: () => void;
}) {
  const pages = useLiveQuery(() => db.pages.toArray(), []) ?? [];
  const tasks = useLiveQuery(() => db.tasks.toArray(), []) ?? [];
  const [draft, setDraft] = useState("");

  const byId = new Map(pages.map((p) => [p.id, p]));
  const alive = (p: Page) => {
    for (let cur: Page | undefined = p; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
      if (cur.deletedAt) return false;
    }
    return true;
  };
  const live = pages.filter(alive);
  const recent = [...live].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
  const favorites = live.filter((p) => p.favorite);
  const t0 = today();
  const due = tasks
    .filter((t) => !t.parentId && !t.done && t.due && t.due <= t0)
    .sort((a, b) => b.priority - a.priority || (a.due ?? "").localeCompare(b.due ?? ""));
  const doneToday = tasks.filter((t) => t.done && dayjs(t.completedAt ?? 0).format("YYYY-MM-DD") === t0).length;

  return (
    <div className="page-shell">
      {sidebarHidden && (
        <header className="topbar">
          <button className="icon-btn" title="顯示側邊欄（Ctrl + \）" onClick={onShowSidebar}>
            <PanelLeftOpen size={16} />
          </button>
        </header>
      )}
      <div className="page-scroll">
        <div className="home">
          <p className="home-date">{dayjs().format("M 月 D 日 dddd")}</p>
          <h1>{greeting()}</h1>

          <div className="home-actions">
            <button className="btn" onClick={async () => openPage(await createPage(null))}>
              <FilePlus2 size={15} /> 新頁面
            </button>
            <button className="btn" onClick={async () => openPage(await openDailyNote())}>
              <NotebookPen size={15} /> 今日筆記
            </button>
            <button className="btn" onClick={() => navigate("/tasks/week")}>
              <CalendarDays size={15} /> 本週待辦
            </button>
          </div>

          <section>
            <h2>
              今天的待辦
              <span className="muted small">
                {due.length} 項未完成{doneToday > 0 && `・已完成 ${doneToday} 項`}
              </span>
            </h2>
            <div className="home-card">
              {due.slice(0, 8).map((t) => (
                <label key={t.id} className="home-task">
                  <input
                    type="checkbox"
                    className={"task-check p" + t.priority}
                    checked={false}
                    onChange={() => void toggleTask(t.id)}
                  />
                  <span className="task-title">{t.title}</span>
                  {t.due! < t0 && <span className="task-meta warn">已過期</span>}
                  {t.dueTime && <span className="task-meta">{t.dueTime}</span>}
                </label>
              ))}
              {due.length > 8 && (
                <button className="add-row" onClick={() => navigate("/tasks/today")}>
                  還有 {due.length - 8} 項…
                </button>
              )}
              <form
                className="quick-add small"
                onSubmit={(e) => {
                  e.preventDefault();
                  const parsed = parseQuickAdd(draft);
                  if (!parsed.title) return;
                  void addTask({ ...parsed, due: parsed.due ?? t0 });
                  setDraft("");
                }}
              >
                <Plus size={14} />
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={due.length ? "再加一項今天要做的事" : "今天沒有待辦。想做點什麼？"}
                  aria-label="新增今天的任務"
                />
              </form>
            </div>
          </section>

          <section>
            <h2>最近編輯</h2>
            <div className="home-grid">
              {recent.map((p) => (
                <button key={p.id} className="home-page" onClick={() => openPage(p.id)}>
                  <span className="home-page-icon">{pageIcon(p)}</span>
                  <span className="home-page-title">{p.title || "未命名"}</span>
                  <span className="muted small">
                    {p.parentId && byId.get(p.parentId) ? `${byId.get(p.parentId)!.title || "未命名"}・` : ""}
                    {ago(p.updatedAt)}
                  </span>
                </button>
              ))}
              {recent.length === 0 && <p className="muted">還沒有頁面，按上面的「新頁面」開始。</p>}
            </div>
          </section>

          {favorites.length > 0 && (
            <section>
              <h2>我的最愛</h2>
              <div className="home-card">
                {favorites.map((p) => (
                  <button key={p.id} className="db-list-row" onClick={() => openPage(p.id)}>
                    <Star size={14} className="starred" fill="currentColor" />
                    <span className="card-title">
                      {pageIcon(p)} {p.title || "未命名"}
                    </span>
                    <span className="muted small">{ago(p.updatedAt)}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
