import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  CheckSquare,
  FileDown,
  House,
  NotebookPen,
  ChevronRight,
  Copy,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  Star,
  Table2,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  createDatabase,
  createPage,
  db,
  deletePageForever,
  duplicatePage,
  movePage,
  openDailyNote,
  placePage,
  restorePage,
  trashPage,
  updatePage,
} from "../db";
import type { Page } from "../types";
import { toast } from "../stores";
import { MenuItem, Popover, navigate, openPage, useLocalState } from "../ui";

export const pageIcon = (p: Page) => p.icon ?? (p.kind === "database" ? "🗃️" : "📄");

export default function Sidebar({
  currentId,
  section,
  onSearch,
  onSettings,
  onCollapse,
}: {
  currentId?: string;
  section: string;
  onSearch: () => void;
  onSettings: () => void;
  onCollapse: () => void;
}) {
  const pages = useLiveQuery(() => db.pages.toArray(), []) ?? [];
  const [expanded, setExpanded] = useLocalState<Record<string, boolean>>("expanded", {});
  const [dropRoot, setDropRoot] = useState(false);

  const live = pages.filter((p) => !p.deletedAt && !p.isRow);
  const children = (parentId: string) =>
    live.filter((p) => p.parentId === parentId).sort((a, b) => a.sort - b.sort);
  const roots = children("");
  // A page is reachable only if none of its ancestors is trashed.
  const byId = new Map(pages.map((p) => [p.id, p]));
  const reachable = (p: Page): boolean => {
    let cur: Page | undefined = p;
    while (cur) {
      if (cur.deletedAt) return false;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return true;
  };
  const favorites = pages.filter((p) => p.favorite && reachable(p));
  const trashed = pages.filter((p) => p.deletedAt).sort((a, b) => b.deletedAt! - a.deletedAt!);

  const toggle = (id: string, open?: boolean) =>
    setExpanded((e) => ({ ...e, [id]: open ?? !e[id] }));

  const add = async (parentId: string | null, kind: "page" | "database" = "page") => {
    const id = kind === "page" ? await createPage(parentId) : await createDatabase(parentId);
    if (parentId) toggle(parentId, true);
    openPage(id);
  };

  const importMarkdown = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,.txt,text/markdown,text/plain";
    input.multiple = true;
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      let last: string | null = null;
      for (const f of files) {
        const text = await f.text();
        // a leading "# Title" becomes the page title
        const m = text.match(/^\s*#\s+(.+)\r?\n/);
        const title = m ? m[1].trim() : f.name.replace(/\.(md|markdown|txt)$/i, "");
        const { markdownToBlocks } = await import("./Editor");
        const content = markdownToBlocks(m ? text.slice(m[0].length) : text);
        last = await createPage(null, { title });
        await updatePage(last, { content });
      }
      if (last) {
        openPage(last);
        toast(`已匯入 ${files.length} 個檔案`);
      }
    };
    input.click();
  };

  const renderNode = (p: Page, depth: number, nextId: string | null = null): JSX.Element => {
    const kids = p.kind === "database" ? [] : children(p.id);
    const open = !!expanded[p.id];
    return (
      <div key={p.id}>
        <TreeRow
          page={p}
          nextId={nextId}
          depth={depth}
          open={open}
          hasKids={kids.length > 0}
          active={p.id === currentId}
          onToggle={() => toggle(p.id)}
          onAdd={p.kind === "page" ? () => void add(p.id) : undefined}
          onDropPage={(id) => {
            if (p.kind === "page") {
              void movePage(id, p.id);
              toggle(p.id, true);
            }
          }}
        />
        {open && kids.map((k, i) => renderNode(k, depth + 1, kids[i + 1]?.id ?? null))}
        {open && kids.length === 0 && p.kind === "page" && (
          <div className="tree-empty" style={{ paddingLeft: 30 + depth * 14 }}>
            沒有子頁面
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <div className="side-top">
        <span className="brand">
          <span className="brand-mark" aria-hidden />
          Slate
        </span>
        <button className="icon-btn" title="收合側邊欄（Ctrl + \）" onClick={onCollapse}>
          <PanelLeftClose size={16} />
        </button>
      </div>

      <button className="nav-row" onClick={onSearch}>
        <span className="nav-icon">
          <Search size={15} />
        </span>
        <span className="nav-label">搜尋</span>
        <kbd>Ctrl K</kbd>
      </button>
      <button className={"nav-row" + (section === "home" ? " active" : "")} onClick={() => navigate("/home")}>
        <span className="nav-icon">
          <House size={15} />
        </span>
        <span className="nav-label">首頁</span>
      </button>
      <button className="nav-row" onClick={async () => openPage(await openDailyNote())}>
        <span className="nav-icon">
          <NotebookPen size={15} />
        </span>
        <span className="nav-label">今日筆記</span>
      </button>
      <button
        className={"nav-row" + (section === "tasks" ? " active" : "")}
        onClick={() => navigate("/tasks/today")}
      >
        <span className="nav-icon">
          <CheckSquare size={15} />
        </span>
        <span className="nav-label">待辦</span>
      </button>

      <div className="side-scroll">
        {favorites.length > 0 && (
          <>
            <div className="nav-heading">我的最愛</div>
            {favorites.map((p) => (
              <button
                key={p.id}
                className={"nav-row" + (p.id === currentId ? " active" : "")}
                onClick={() => openPage(p.id)}
              >
                <span className="nav-icon">{pageIcon(p)}</span>
                <span className="nav-label">{p.title || "未命名"}</span>
              </button>
            ))}
          </>
        )}

        <div
          className={"nav-heading" + (dropRoot ? " over" : "")}
          onDragOver={(e) => {
            e.preventDefault();
            setDropRoot(true);
          }}
          onDragLeave={() => setDropRoot(false)}
          onDrop={(e) => {
            setDropRoot(false);
            const id = e.dataTransfer.getData("text/page");
            if (id) void movePage(id, null);
          }}
        >
          頁面
          <Popover
            width={170}
            trigger={(p) => (
              <button className="icon-btn" title="新增頁面或資料庫" {...p}>
                <Plus size={14} />
              </button>
            )}
          >
            {(close) => (
              <div className="menu">
                <MenuItem
                  icon="📄"
                  onClick={() => {
                    void add(null);
                    close();
                  }}
                >
                  空白頁面
                </MenuItem>
                <MenuItem
                  icon={<Table2 size={14} />}
                  onClick={() => {
                    void add(null, "database");
                    close();
                  }}
                >
                  資料庫
                </MenuItem>
                <MenuItem
                  icon={<FileDown size={14} />}
                  onClick={() => {
                    importMarkdown();
                    close();
                  }}
                >
                  匯入 Markdown
                </MenuItem>
              </div>
            )}
          </Popover>
        </div>
        {roots.map((p, i) => renderNode(p, 0, roots[i + 1]?.id ?? null))}
        {roots.length === 0 && (
          <button className="nav-row muted" onClick={() => void add(null)}>
            <span className="nav-icon">
              <Plus size={15} />
            </span>
            <span className="nav-label">建立第一個頁面</span>
          </button>
        )}
      </div>

      <div className="side-bottom">
        <Popover
          width={320}
          trigger={(p) => (
            <button className="nav-row" {...p}>
              <span className="nav-icon">
                <Trash2 size={15} />
              </span>
              <span className="nav-label">垃圾桶</span>
              {trashed.length > 0 && <span className="nav-count">{trashed.length}</span>}
            </button>
          )}
        >
          {() => (
            <div className="menu trash">
              {trashed.length === 0 && <div className="hint">垃圾桶是空的</div>}
              {trashed.map((p) => (
                <div key={p.id} className="trash-row">
                  <span className="nav-icon">{pageIcon(p)}</span>
                  <span className="nav-label">{p.title || "未命名"}</span>
                  <button className="icon-btn" title="還原" onClick={() => void restorePage(p.id)}>
                    <Undo2 size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    title="永久刪除"
                    onClick={() => {
                      if (confirm(`永久刪除「${p.title || "未命名"}」與它底下的所有內容？此動作無法復原。`)) {
                        void deletePageForever(p.id);
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Popover>
        <button className="nav-row" onClick={onSettings}>
          <span className="nav-icon">
            <Settings size={15} />
          </span>
          <span className="nav-label">設定與備份</span>
        </button>
      </div>
    </aside>
  );
}

function TreeRow({
  page,
  depth,
  open,
  hasKids,
  active,
  onToggle,
  onAdd,
  onDropPage,
  nextId,
}: {
  page: Page;
  /** id of the sibling right after this one, or null when it is the last */
  nextId: string | null;
  depth: number;
  open: boolean;
  hasKids: boolean;
  active: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  onDropPage: (id: string) => void;
}) {
  // where a dragged page would land: above this row, inside it, or below it
  const [zone, setZone] = useState<"before" | "inside" | "after" | null>(null);
  const zoneAt = (e: React.DragEvent): "before" | "inside" | "after" => {
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    if (page.kind !== "page") return y < 0.5 ? "before" : "after";
    return y < 0.28 ? "before" : y > 0.72 ? "after" : "inside";
  };
  return (
    <div
      className={"tree-row" + (active ? " active" : "") + (zone ? " over-" + zone : "")}
      style={{ paddingLeft: 6 + depth * 14 }}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/page", page.id);
        e.dataTransfer.effectAllowed = "move";
        e.stopPropagation();
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("text/page")) return;
        e.preventDefault();
        setZone(zoneAt(e));
      }}
      onDragLeave={() => setZone(null)}
      onDrop={(e) => {
        const z = zoneAt(e);
        setZone(null);
        const id = e.dataTransfer.getData("text/page");
        if (!id || id === page.id) return;
        e.preventDefault();
        if (z === "inside") onDropPage(id);
        else void placePage(id, page.parentId || null, z === "before" ? page.id : nextId);
      }}
    >
      <button
        className={"icon-btn chevron" + (open ? " open" : "")}
        aria-label={open ? "收合" : "展開"}
        aria-expanded={open}
        style={{ visibility: page.kind === "database" ? "hidden" : "visible" }}
        onClick={onToggle}
      >
        <ChevronRight size={14} className={hasKids ? "" : "faint"} />
      </button>
      <button className="tree-main" onClick={() => openPage(page.id)} aria-current={active ? "page" : undefined}>
        <span className="nav-icon">{pageIcon(page)}</span>
        <span className="nav-label">{page.title || "未命名"}</span>
      </button>
      <span className="tree-actions">
        <Popover
          width={190}
          trigger={(p) => (
            <button className="icon-btn" title="更多" {...p}>
              <MoreHorizontal size={14} />
            </button>
          )}
        >
          {(close) => (
            <div className="menu">
              <MenuItem
                icon={<Star size={14} />}
                onClick={() => {
                  void updatePage(page.id, { favorite: !page.favorite });
                  close();
                }}
              >
                {page.favorite ? "從最愛移除" : "加入最愛"}
              </MenuItem>
              <MenuItem
                icon={<Copy size={14} />}
                onClick={async () => {
                  close();
                  const id = await duplicatePage(page.id);
                  if (id) openPage(id);
                }}
              >
                建立副本
              </MenuItem>
              <MenuItem
                danger
                icon={<Trash2 size={14} />}
                onClick={() => {
                  void trashPage(page.id);
                  toast(`已將「${page.title || "未命名"}」移到垃圾桶`, {
                    label: "復原",
                    run: () => void restorePage(page.id),
                  });
                  close();
                }}
              >
                移到垃圾桶
              </MenuItem>
            </div>
          )}
        </Popover>
        {onAdd && (
          <button className="icon-btn" title="新增子頁面" onClick={onAdd}>
            <Plus size={14} />
          </button>
        )}
      </span>
    </div>
  );
}
