import { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Calendar,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Flame,
  Grid2x2,
  Inbox,
  ListTodo,
  Pause,
  Play,
  Plus,
  Repeat as RepeatIcon,
  RotateCcw,
  Sun,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import { addTask, db, deleteList, deleteTask, toggleTask } from "../../db";
import { chime, focus, useFocus } from "../../lib/focus";
import { habitStreak, parseQuickAdd, quadrant, today, uid } from "../../lib/logic";
import type { Repeat, Task, TaskList } from "../../types";
import { toast } from "../../stores";
import { CommitInput, LiveInput, navigate } from "../../ui";
import { monthGrid } from "../database/DatabaseView";

const SMART = [
  { id: "today", label: "今天", icon: <Sun size={15} /> },
  { id: "week", label: "最近 7 天", icon: <CalendarDays size={15} /> },
  { id: "inbox", label: "收件匣", icon: <Inbox size={15} /> },
  { id: "all", label: "全部", icon: <ListTodo size={15} /> },
  { id: "calendar", label: "月曆", icon: <Calendar size={15} /> },
  { id: "matrix", label: "四象限", icon: <Grid2x2 size={15} /> },
  { id: "done", label: "已完成", icon: <CheckCircle2 size={15} /> },
];

const TOOLS = [
  { id: "focus", label: "番茄鐘", icon: <Timer size={15} /> },
  { id: "habits", label: "習慣打卡", icon: <Flame size={15} /> },
];

const REPEAT_LABEL: Record<Repeat, string> = {
  daily: "每天",
  weekdays: "每個工作日",
  weekly: "每週",
  monthly: "每月",
  yearly: "每年",
};

const PRIORITY_LABEL = ["無", "低", "中", "高"];
const LIST_COLORS = ["#2f6f5e", "#c2622d", "#3b6fb6", "#8a5cb8", "#b8447a", "#a08a1c"];

function dueLabel(due: string): string {
  const diff = dayjs(due).diff(dayjs(today()), "day");
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  if (diff === -1) return "昨天";
  return dayjs(due).format(dayjs(due).year() === dayjs().year() ? "M/D" : "YYYY/M/D");
}

const byOrder = (a: Task, b: Task) =>
  b.priority - a.priority ||
  (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
  a.sort - b.sort;

export default function TasksView({ view }: { view: string }) {
  const tasks = useLiveQuery(() => db.tasks.toArray(), []) ?? [];
  const lists = (useLiveQuery(() => db.lists.toArray(), []) ?? []).sort((a, b) => a.sort - b.sort);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setSelected(null), [view]);

  const top = tasks.filter((t) => !t.parentId);
  const open = top.filter((t) => !t.done);
  const t0 = today();
  const weekEnd = dayjs(t0).add(6, "day").format("YYYY-MM-DD");

  const counts: Record<string, number> = {
    today: open.filter((t) => t.due && t.due <= t0).length,
    week: open.filter((t) => t.due && t.due <= weekEnd).length,
    inbox: open.filter((t) => !t.listId).length,
    all: open.length,
  };
  for (const l of lists) counts[l.id] = open.filter((t) => t.listId === l.id).length;

  const list = lists.find((l) => l.id === view);
  const title = SMART.find((s) => s.id === view)?.label ?? TOOLS.find((s) => s.id === view)?.label ?? list?.name;
  const selectedTask = tasks.find((t) => t.id === selected);

  const addList = async () => {
    const id = uid();
    await db.lists.add({
      id,
      name: "新清單",
      color: LIST_COLORS[lists.length % LIST_COLORS.length],
      sort: Date.now(),
    });
    navigate("/tasks/" + id);
  };

  return (
    <div className="tasks">
      <nav className="tasks-nav" aria-label="待辦清單">
        {SMART.map((s) => (
          <NavRow key={s.id} id={s.id} active={view === s.id} icon={s.icon} label={s.label} count={counts[s.id]} />
        ))}
        <div className="nav-heading">
          清單
          <button className="icon-btn" title="新增清單" onClick={() => void addList()}>
            <Plus size={14} />
          </button>
        </div>
        {lists.map((l) => (
          <NavRow
            key={l.id}
            id={l.id}
            active={view === l.id}
            icon={<span className="dot" style={{ background: l.color }} />}
            label={l.name}
            count={counts[l.id]}
          />
        ))}
        {lists.length === 0 && <div className="hint">用清單把任務分門別類</div>}
        <div className="nav-heading">工具</div>
        {TOOLS.map((s) => (
          <NavRow key={s.id} id={s.id} active={view === s.id} icon={s.icon} label={s.label} />
        ))}
      </nav>

      <section className="tasks-main">
        {!title ? (
          <div className="empty">
            <p>找不到這個清單。</p>
            <button className="btn primary" onClick={() => navigate("/tasks/today")}>
              回到今天
            </button>
          </div>
        ) : view === "focus" ? (
          <FocusView tasks={open} />
        ) : view === "habits" ? (
          <HabitsView />
        ) : view === "matrix" ? (
          <Matrix tasks={open} selected={selected} onSelect={setSelected} />
        ) : view === "calendar" ? (
          <TaskCalendar tasks={top} onSelect={setSelected} />
        ) : (
          <TaskListPane
            view={view}
            title={title}
            list={list}
            tasks={top}
            all={tasks}
            selected={selected}
            onSelect={setSelected}
          />
        )}
      </section>

      {selectedTask && (
        <TaskDetail
          key={selectedTask.id}
          task={selectedTask}
          lists={lists}
          subtasks={tasks.filter((t) => t.parentId === selectedTask.id).sort((a, b) => a.sort - b.sort)}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function NavRow({
  id,
  active,
  icon,
  label,
  count,
}: {
  id: string;
  active: boolean;
  icon: JSX.Element;
  label: string;
  count?: number;
}) {
  return (
    <button
      className={"nav-row" + (active ? " active" : "")}
      aria-current={active ? "page" : undefined}
      onClick={() => navigate("/tasks/" + id)}
    >
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
      {!!count && <span className="nav-count">{count}</span>}
    </button>
  );
}

// ---------- list pane ----------

function TaskListPane({
  view,
  title,
  list,
  tasks,
  all,
  selected,
  onSelect,
}: {
  view: string;
  title: string;
  list?: TaskList;
  tasks: Task[];
  all: Task[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [showDone, setShowDone] = useState(false);
  const t0 = today();
  const weekEnd = dayjs(t0).add(6, "day").format("YYYY-MM-DD");

  const inView = (t: Task) => {
    switch (view) {
      case "today":
        return !!t.due && t.due <= t0;
      case "week":
        return !!t.due && t.due <= weekEnd;
      case "inbox":
        return !t.listId;
      case "all":
      case "done":
        return true;
      default:
        return t.listId === view;
    }
  };

  const open = tasks.filter((t) => !t.done && inView(t)).sort(byOrder);
  const doneIn = (t: Task) => {
    if (view === "today" || view === "week") {
      return dayjs(t.completedAt ?? 0).format("YYYY-MM-DD") === t0;
    }
    if (view === "inbox") return !t.listId;
    if (view === "all" || view === "done") return true;
    return t.listId === view;
  };
  const done = tasks
    .filter((t) => t.done && doneIn(t))
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));

  const groups = useMemo(() => {
    if (view === "done") return [];
    if (view === "today" || view === "week") {
      const overdue = open.filter((t) => t.due! < t0);
      const out: { label: string; items: Task[]; warn?: boolean }[] = [];
      if (overdue.length) out.push({ label: "已過期", items: overdue, warn: true });
      const rest = open.filter((t) => t.due! >= t0);
      for (const d of [...new Set(rest.map((t) => t.due!))].sort()) {
        out.push({
          label: `${dueLabel(d)}　${dayjs(d).format("M月D日 dddd")}`,
          items: rest.filter((t) => t.due === d),
        });
      }
      return out;
    }
    return open.length ? [{ label: "", items: open }] : [];
  }, [open, view, t0]);

  const submit = async () => {
    const parsed = parseQuickAdd(draft);
    if (!parsed.title) return;
    setDraft("");
    await addTask({
      ...parsed,
      due: parsed.due ?? (view === "today" || view === "week" ? t0 : null),
      listId: list ? list.id : null,
    });
  };

  const subCount = (id: string) => {
    const subs = all.filter((t) => t.parentId === id);
    return subs.length ? `${subs.filter((s) => s.done).length}/${subs.length}` : "";
  };

  return (
    <div className="task-pane">
      <header className="task-head">
        {list ? (
          <>
            <span className="dot big" style={{ background: list.color }} />
            <CommitInput
              className="h-input"
              value={list.name}
              aria-label="清單名稱"
              onCommit={(name) => void db.lists.update(list.id, { name: name.trim() || list.name })}
            />
            <button
              className="icon-btn"
              title="刪除清單（任務會移到收件匣）"
              onClick={() => {
                if (confirm(`刪除清單「${list.name}」？裡面的任務會移到收件匣。`)) {
                  void deleteList(list.id);
                  navigate("/tasks/inbox");
                }
              }}
            >
              <Trash2 size={15} />
            </button>
          </>
        ) : (
          <h1>{title}</h1>
        )}
      </header>

      {view !== "done" && (
        <form
          className="quick-add"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Plus size={16} />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="新增任務，按 Enter 儲存（可寫「明天 交報告 !3 #工作」）"
            aria-label="新增任務"
          />
        </form>
      )}

      {groups.map((g) => (
        <div key={g.label} className="task-group">
          {g.label && <div className={"group-label" + (g.warn ? " warn" : "")}>{g.label}</div>}
          {g.items.map((t) => (
            <TaskRow key={t.id} task={t} sub={subCount(t.id)} active={selected === t.id} onSelect={onSelect} />
          ))}
        </div>
      ))}

      {view !== "done" && open.length === 0 && (
        <div className="empty small">
          <p>{view === "today" ? "今天沒有待辦，享受空檔吧。" : "這裡還沒有任務。"}</p>
        </div>
      )}

      {view === "done" ? (
        done.length ? (
          done.map((t) => <TaskRow key={t.id} task={t} sub="" active={selected === t.id} onSelect={onSelect} />)
        ) : (
          <div className="empty small">
            <p>還沒有完成的任務。</p>
          </div>
        )
      ) : (
        done.length > 0 && (
          <div className="task-group">
            <button className="group-label toggle" onClick={() => setShowDone(!showDone)}>
              <ChevronRight size={13} className={showDone ? "rot" : ""} /> 已完成 {done.length}
            </button>
            {showDone &&
              done.map((t) => (
                <TaskRow key={t.id} task={t} sub="" active={selected === t.id} onSelect={onSelect} />
              ))}
          </div>
        )
      )}
    </div>
  );
}

function Check({ task }: { task: Task }) {
  return (
    <input
      type="checkbox"
      className={"task-check p" + task.priority}
      checked={task.done}
      onChange={() => void toggleTask(task.id)}
      onClick={(e) => e.stopPropagation()}
      aria-label={(task.done ? "取消完成：" : "完成：") + task.title}
    />
  );
}

function TaskRow({
  task,
  sub,
  active,
  onSelect,
}: {
  task: Task;
  sub: string;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const overdue = !task.done && !!task.due && task.due < today();
  return (
    <div
      className={"task-row" + (active ? " active" : "") + (task.done ? " done" : "")}
      onClick={() => onSelect(task.id)}
    >
      <Check task={task} />
      <button className="task-title" onClick={() => onSelect(task.id)}>
        {task.title}
      </button>
      {task.tags?.map((t) => (
        <span key={t} className="tag tag-gray">
          #{t}
        </span>
      ))}
      {sub && <span className="task-meta">{sub}</span>}
      {task.repeat && <RepeatIcon size={12} className="task-meta" aria-label="重複任務" />}
      {task.due && (
        <span className={"task-meta" + (overdue ? " warn" : "")}>
          {dueLabel(task.due)}
          {task.dueTime ? " " + task.dueTime : ""}
        </span>
      )}
    </div>
  );
}

// ---------- detail ----------

function TaskDetail({
  task,
  lists,
  subtasks,
  onClose,
}: {
  task: Task;
  lists: TaskList[];
  subtasks: Task[];
  onClose: () => void;
}) {
  const set = (patch: Partial<Task>) => void db.tasks.update(task.id, patch);
  const [sub, setSub] = useState("");
  return (
    <aside className="task-detail" aria-label="任務詳情">
      <div className="detail-head">
        <Check task={task} />
        <LiveInput
          className="h-input"
          value={task.title}
          aria-label="任務名稱"
          onSave={(title) => set({ title: title.trim() || task.title })}
        />
        <button className="icon-btn" title="關閉" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      <div className="detail-grid">
        <label>日期</label>
        <span className="row">
          <input
            type="date"
            className="input"
            value={task.due ?? ""}
            onChange={(e) => set({ due: e.target.value || null, ...(e.target.value ? {} : { repeat: null, dueTime: null }) })}
          />
          <input
            type="time"
            className="input"
            value={task.dueTime ?? ""}
            disabled={!task.due}
            aria-label="時間"
            onChange={(e) => {
              set({ dueTime: e.target.value || null });
              if (e.target.value && "Notification" in window && Notification.permission === "default") {
                void Notification.requestPermission();
              }
            }}
          />
        </span>
        <label>重複</label>
        <select
          className="input"
          value={task.repeat ?? ""}
          disabled={!task.due}
          title={task.due ? undefined : "先設定日期才能重複"}
          onChange={(e) => set({ repeat: (e.target.value || null) as Repeat | null })}
        >
          <option value="">不重複</option>
          {(Object.keys(REPEAT_LABEL) as Repeat[]).map((r) => (
            <option key={r} value={r}>
              {REPEAT_LABEL[r]}
            </option>
          ))}
        </select>
        <label>優先級</label>
        <span className="seg">
          {[0, 1, 2, 3].map((p) => (
            <button
              key={p}
              className={"seg-btn p" + p + (task.priority === p ? " active" : "")}
              onClick={() => set({ priority: p as Task["priority"] })}
            >
              {PRIORITY_LABEL[p]}
            </button>
          ))}
        </span>
        <label>清單</label>
        <select
          className="input"
          value={task.listId ?? ""}
          onChange={(e) => set({ listId: e.target.value || null })}
        >
          <option value="">收件匣</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <label>標籤</label>
        <CommitInput
          className="input"
          value={(task.tags ?? []).join(" ")}
          placeholder="用空白分隔"
          aria-label="標籤"
          onCommit={(v) => set({ tags: v.split(/[\s,#]+/).filter(Boolean) })}
        />
      </div>

      <div className="detail-section">子任務</div>
      {subtasks.map((s) => (
        <div key={s.id} className={"task-row sub" + (s.done ? " done" : "")}>
          <Check task={s} />
          <CommitInput
            className="cell-input"
            value={s.title}
            aria-label="子任務名稱"
            onCommit={(title) => void db.tasks.update(s.id, { title: title.trim() || s.title })}
          />
          <button className="icon-btn" title="刪除子任務" onClick={() => void deleteTask(s.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
      <form
        className="quick-add small"
        onSubmit={(e) => {
          e.preventDefault();
          if (!sub.trim()) return;
          void addTask({ title: sub.trim(), parentId: task.id, listId: task.listId });
          setSub("");
        }}
      >
        <Plus size={14} />
        <input value={sub} onChange={(e) => setSub(e.target.value)} placeholder="新增子任務" aria-label="新增子任務" />
      </form>

      <div className="detail-section">備註</div>
      <LiveInput
        multiline
        className="input note"
        value={task.note ?? ""}
        placeholder="寫點補充說明…"
        aria-label="備註"
        onSave={(note) => set({ note })}
      />

      <div className="detail-foot">
        <button
          className="btn ghost small"
          onClick={() => {
            focus.configure({ taskId: task.id });
            navigate("/tasks/focus");
          }}
        >
          <Timer size={14} /> 開始專注
        </button>
        <span className="spacer" />
        <button
          className="btn ghost small danger"
          onClick={() => {
            void deleteTask(task.id);
            onClose();
          }}
        >
          <Trash2 size={14} /> 刪除
        </button>
      </div>
    </aside>
  );
}

// ---------- matrix ----------

const QUADRANTS: { q: 1 | 2 | 3 | 4; title: string; hint: string }[] = [
  { q: 1, title: "重要且緊急", hint: "馬上做" },
  { q: 2, title: "重要不緊急", hint: "排時間做" },
  { q: 3, title: "緊急不重要", hint: "快速處理或交給別人" },
  { q: 4, title: "不重要不緊急", hint: "有空再說" },
];

/** What changes when a task is dropped into a quadrant. */
function moveToQuadrant(t: Task, q: 1 | 2 | 3 | 4): Partial<Task> {
  const t0 = today();
  const urgentNow = quadrant(t) === 1 || quadrant(t) === 3;
  const important = q <= 2;
  const urgent = q === 1 || q === 3;
  return {
    priority: important ? (Math.max(t.priority, 2) as Task["priority"]) : (Math.min(t.priority, 1) as Task["priority"]),
    due: urgent
      ? urgentNow
        ? t.due
        : t0
      : urgentNow
        ? dayjs(t0).add(7, "day").format("YYYY-MM-DD")
        : t.due,
  };
}

function Matrix({
  tasks,
  selected,
  onSelect,
}: {
  tasks: Task[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [over, setOver] = useState<number | null>(null);
  return (
    <div className="task-pane wide matrix-pane">
      <header className="task-head">
        <h1>四象限</h1>
        <span className="muted small">重要 = 優先級中或高；緊急 = 明天以前到期。拖曳任務可以改變它的象限。</span>
      </header>
      <div className="matrix">
        {QUADRANTS.map(({ q, title, hint }) => {
          const items = tasks.filter((t) => quadrant(t) === q).sort(byOrder);
          return (
            <section
              key={q}
              className={"quad q" + q + (over === q ? " over" : "")}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(q);
              }}
              onDragLeave={() => setOver((o) => (o === q ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const t = tasks.find((x) => x.id === e.dataTransfer.getData("text/task"));
                if (t && quadrant(t) !== q) void db.tasks.update(t.id, moveToQuadrant(t, q));
              }}
            >
              <h2>
                {title}
                <span className="muted small">{hint}・{items.length}</span>
              </h2>
              {items.map((t) => (
                <div
                  key={t.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/task", t.id)}
                >
                  <TaskRow task={t} sub="" active={selected === t.id} onSelect={onSelect} />
                </div>
              ))}
              {items.length === 0 && <p className="hint">沒有任務</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}

// ---------- calendar ----------

function TaskCalendar({ tasks, onSelect }: { tasks: Task[]; onSelect: (id: string) => void }) {
  const [month, setMonth] = useState(() => dayjs().startOf("month"));
  const byDay = new Map<string, Task[]>();
  for (const t of tasks) if (t.due) byDay.set(t.due, [...(byDay.get(t.due) ?? []), t]);
  return (
    <div className="task-pane wide">
      <div className="calendar">
        <div className="cal-head">
          <h1>{month.format("YYYY 年 M 月")}</h1>
          <span className="spacer" />
          <button className="icon-btn" title="上個月" onClick={() => setMonth(month.subtract(1, "month"))}>
            <ChevronLeft size={16} />
          </button>
          <button className="btn ghost small" onClick={() => setMonth(dayjs().startOf("month"))}>
            今天
          </button>
          <button className="icon-btn" title="下個月" onClick={() => setMonth(month.add(1, "month"))}>
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="cal-grid">
          {"日一二三四五六".split("").map((d) => (
            <div key={d} className="cal-dow">
              {d}
            </div>
          ))}
          {monthGrid(month).map((d) => {
            const key = d.format("YYYY-MM-DD");
            return (
              <div
                key={key}
                className={"cal-day" + (d.month() !== month.month() ? " other" : "") + (key === today() ? " today" : "")}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const id = e.dataTransfer.getData("text/task");
                  if (id) void db.tasks.update(id, { due: key });
                }}
              >
                <div className="cal-num">
                  <span>{d.date()}</span>
                  <button
                    className="icon-btn cal-add"
                    title={`在 ${key} 新增任務`}
                    onClick={async () => onSelect(await addTask({ title: "新任務", due: key }))}
                  >
                    <Plus size={12} />
                  </button>
                </div>
                {(byDay.get(key) ?? []).sort(byOrder).map((t) => (
                  <button
                    key={t.id}
                    className={"cal-item p" + t.priority + (t.done ? " done" : "")}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/task", t.id)}
                    onClick={() => onSelect(t.id)}
                  >
                    {t.title}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------- pomodoro ----------

const fmt = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** Mounted once at the app root: keeps the countdown going on every screen. */
export function FocusTicker() {
  const state = useFocus();
  useEffect(() => {
    if (!state.endAt) {
      document.title = "Slate 離線工作區";
      return;
    }
    const run = async () => {
      document.title = `${fmt(focus.left())} 專注中`;
      if (await focus.tick()) {
        chime();
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification("專注完成", { body: "休息一下吧。" });
        }
      }
    };
    void run();
    const t = setInterval(run, 500);
    return () => clearInterval(t);
  }, [state.endAt]);
  return null;
}

/** Mounted once at the app root: notifies when a timed task comes due. */
export function ReminderTicker() {
  useEffect(() => {
    const check = async () => {
      const day = today();
      const now = dayjs().format("HH:mm");
      const key = "reminded:" + day;
      let seen: string[] = [];
      try {
        seen = JSON.parse(localStorage.getItem(key) ?? "[]");
      } catch {
        /* ignore */
      }
      const due = (await db.tasks.where("due").equals(day).toArray()).filter(
        (t) => !t.done && t.dueTime && t.dueTime <= now && !seen.includes(t.id),
      );
      if (due.length === 0) return;
      for (const t of due) {
        toast(`⏰ ${t.dueTime} ${t.title}`, { label: "查看", run: () => navigate("/tasks/today") });
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification("任務到期", { body: `${t.dueTime} ${t.title}` });
        }
      }
      chime();
      localStorage.setItem(key, JSON.stringify([...seen, ...due.map((t) => t.id)]));
    };
    void check();
    const t = setInterval(check, 20_000);
    return () => clearInterval(t);
  }, []);
  return null;
}

function FocusView({ tasks }: { tasks: Task[] }) {
  const state = useFocus();
  const [, force] = useState(0);
  useEffect(() => {
    if (!state.endAt) return;
    const t = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [state.endAt]);

  const sessions = useLiveQuery(() => db.focus.toArray(), []) ?? [];
  const days = Array.from({ length: 7 }, (_, i) => dayjs().subtract(6 - i, "day"));
  const perDay = days.map((d) =>
    sessions
      .filter((s) => dayjs(s.start).isSame(d, "day"))
      .reduce((m, s) => m + s.minutes, 0),
  );
  const max = Math.max(60, ...perDay);
  const todayCount = sessions.filter((s) => dayjs(s.start).isSame(dayjs(), "day")).length;

  const running = !!state.endAt;
  const paused = state.remaining !== null;
  const left = focus.left();
  const total = state.minutes * 60_000;
  const R = 110;
  const C = 2 * Math.PI * R;

  return (
    <div className="task-pane focus">
      <header className="task-head">
        <h1>番茄鐘</h1>
      </header>
      <div className="focus-clock">
        <svg viewBox="0 0 260 260" role="img" aria-label={`剩餘 ${fmt(left)}`}>
          <circle cx="130" cy="130" r={R} className="ring-bg" />
          <circle
            cx="130"
            cy="130"
            r={R}
            className="ring-fg"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - left / total)}
            transform="rotate(-90 130 130)"
          />
        </svg>
        <div className="focus-time">{fmt(left)}</div>
      </div>

      <div className="focus-controls">
        {running ? (
          <button className="btn primary" onClick={() => focus.pause()}>
            <Pause size={16} /> 暫停
          </button>
        ) : (
          <button
            className="btn primary"
            onClick={() => {
              if ("Notification" in window && Notification.permission === "default") {
                void Notification.requestPermission();
              }
              focus.start();
            }}
          >
            <Play size={16} /> {paused ? "繼續" : "開始專注"}
          </button>
        )}
        {(running || paused) && (
          <button className="btn ghost" onClick={() => focus.reset()}>
            <RotateCcw size={15} /> 放棄
          </button>
        )}
      </div>

      <div className="focus-config">
        <label>
          時長
          <span className="seg">
            {[15, 25, 45, 60].map((m) => (
              <button
                key={m}
                disabled={running || paused}
                className={"seg-btn" + (state.minutes === m ? " active" : "")}
                onClick={() => focus.configure({ minutes: m })}
              >
                {m} 分
              </button>
            ))}
          </span>
        </label>
        <label>
          專注於
          <select
            className="input"
            value={state.taskId ?? ""}
            onChange={(e) => focus.configure({ taskId: e.target.value || null })}
          >
            <option value="">（不指定任務）</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="detail-section">
        最近 7 天　今天完成 {todayCount} 個番茄、{perDay[6]} 分鐘
      </div>
      <div className="bars">
        {days.map((d, i) => (
          <div key={i} className="bar-col" title={`${d.format("M/D")}：${perDay[i]} 分鐘`}>
            <span className="bar-val">{perDay[i] || ""}</span>
            <div className="bar" style={{ height: `${(perDay[i] / max) * 100}%` }} />
            <span className="bar-label">{d.format("M/D")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- habits ----------

function HabitsView() {
  const habits = (useLiveQuery(() => db.habits.toArray(), []) ?? []).sort((a, b) => a.createdAt - b.createdAt);
  const [draft, setDraft] = useState("");
  const days = Array.from({ length: 7 }, (_, i) => dayjs().subtract(6 - i, "day"));
  // modify() reads the stored list, so quick taps on several days all stick
  const toggle = (id: string, day: string) =>
    void db.habits
      .where("id")
      .equals(id)
      .modify((h) => {
        h.days = h.days.includes(day) ? h.days.filter((d) => d !== day) : [...h.days, day];
      });

  return (
    <div className="task-pane">
      <header className="task-head">
        <h1>習慣打卡</h1>
      </header>
      <form
        className="quick-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          void db.habits.add({ id: uid(), name: draft.trim(), icon: "🌱", createdAt: Date.now(), days: [] });
          setDraft("");
        }}
      >
        <Plus size={16} />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="新增習慣，例如「喝水 2000ml」"
          aria-label="新增習慣"
        />
      </form>
      {habits.length === 0 ? (
        <div className="empty small">
          <p>還沒有習慣。從一個小的開始。</p>
        </div>
      ) : (
        <table className="habit-table">
          <thead>
            <tr>
              <th />
              {days.map((d) => (
                <th key={d.valueOf()} className={d.isSame(dayjs(), "day") ? "today" : ""}>
                  {"日一二三四五六"[d.day()]}
                  <small>{d.date()}</small>
                </th>
              ))}
              <th>連續</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {habits.map((h) => (
              <tr key={h.id}>
                <td>
                  <CommitInput
                    className="cell-input strong"
                    value={h.name}
                    aria-label="習慣名稱"
                    onCommit={(name) => void db.habits.update(h.id, { name: name.trim() || h.name })}
                  />
                </td>
                {days.map((d) => {
                  const key = d.format("YYYY-MM-DD");
                  const on = h.days.includes(key);
                  return (
                    <td key={key}>
                      <button
                        className={"habit-dot" + (on ? " on" : "")}
                        aria-pressed={on}
                        aria-label={`${h.name} ${key}`}
                        onClick={() => toggle(h.id, key)}
                      />
                    </td>
                  );
                })}
                <td className="streak">{habitStreak(h.days)} 天</td>
                <td>
                  <button
                    className="icon-btn"
                    title="刪除習慣"
                    onClick={() => confirm(`刪除習慣「${h.name}」與它的打卡紀錄？`) && void db.habits.delete(h.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
