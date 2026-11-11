import { useEffect, useMemo, useRef, useState } from "react";
import dayjs from "dayjs";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ChevronRight,
  ChevronsRight,
  Copy,
  CornerUpRight,
  Download,
  History,
  Image as ImageIcon,
  Link2,
  Lock,
  Maximize2,
  MoreHorizontal,
  MoveHorizontal,
  PanelLeftOpen,
  Printer,
  Smile,
  Star,
  Trash2,
  Type,
  Unlock,
  Upload,
} from "lucide-react";
import {
  backlinks,
  breadcrumb,
  db,
  deletePageForever,
  duplicatePage,
  importCsv,
  movePage,
  mutatePage,
  restorePage,
  restoreSnapshot,
  saveFile,
  setRowProp,
  trashPage,
  updatePage,
} from "../db";
import { applyView, blocksToText, cellValue, csvCell, displayValue, outlineOf } from "../lib/logic";
import { TEMPLATES, type Template } from "../lib/templates";
import { peek, toast } from "../stores";
import type { Page } from "../types";
import { EmojiPicker, LiveInput, MenuItem, Modal, Popover, navigate, openPage } from "../ui";
import Editor, { type AppEditor } from "./Editor";
import DatabaseView from "./database/DatabaseView";
import { PropCell } from "./database/PropCell";
import { COVERS, useCoverStyle, useRelated } from "./database/shared";
import { pageIcon } from "./Sidebar";

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safeName = (s: string) => (s || "未命名").replace(/[\\/:*?"<>|]/g, "_");

async function exportCsv(dbPage: Page) {
  const schema = dbPage.schema ?? [];
  const rows = applyView(
    (await db.pages.where("parentId").equals(dbPage.id).toArray()).filter((r) => r.isRow && !r.deletedAt),
    { filters: [], sorts: [] },
    schema,
  );
  const relDbs = schema.filter((p) => p.type === "relation" && p.relationDb).map((p) => p.relationDb!);
  const related = relDbs.length ? await db.pages.where("parentId").anyOf(relDbs).toArray() : [];
  const titles = new Map(related.map((r) => [r.id, r.title]));
  const lines = [
    ["名稱", ...schema.map((p) => p.name)],
    ...rows.map((r) => [
      r.title,
      ...schema.map((p) => displayValue(cellValue(r, p.id, schema, titles), p, titles)),
    ]),
  ].map((l) => l.map(csvCell).join(","));
  // BOM so Excel opens the UTF-8 file with the right encoding
  download(safeName(dbPage.title) + ".csv", "﻿" + lines.join("\r\n"), "text/csv");
}

const isBlank = (content?: unknown[]) => !content?.length || blocksToText(content).trim() === "" && content.length <= 1;

export default function PageView({
  id,
  dark,
  mode = "full",
  sidebarHidden = false,
  onShowSidebar,
}: {
  id: string;
  dark: boolean;
  mode?: "full" | "peek";
  sidebarHidden?: boolean;
  onShowSidebar?: () => void;
}) {
  const page = useLiveQuery(async () => (await db.pages.get(id)) ?? null, [id]);
  const crumbs = useLiveQuery(() => breadcrumb(id), [id, page?.parentId, page?.title, page?.deletedAt]) ?? [];
  const linkedFrom = useLiveQuery(() => backlinks(id), [id, page?.updatedAt]) ?? [];
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2] : undefined;
  const editorRef = useRef<AppEditor | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // after restoring a version the editor is remounted with that version's content
  const [restored, setRestored] = useState<{ n: number; content?: unknown[] }>({ n: 0 });
  const [dialog, setDialog] = useState<"history" | "move" | null>(null);
  const coverStyle = useCoverStyle(page?.cover);
  const parentSchema = page?.isRow ? parent?.schema : undefined;
  const related = useRelated(useMemo(() => parentSchema ?? [], [parentSchema]));
  const outline = useMemo(() => outlineOf(page?.content), [page?.content]);

  useEffect(() => {
    if (page && mode === "full") localStorage.setItem("last-page", page.id);
  }, [page?.id, mode]);

  if (page === undefined) return <div className="page-shell" />;
  if (page === null) {
    return (
      <div className="page-shell">
        <div className="empty">
          <p>找不到這個頁面，可能已被永久刪除。</p>
          <button className="btn primary" onClick={() => (mode === "peek" ? peek.close() : navigate("/"))}>
            {mode === "peek" ? "關閉" : "回到首頁"}
          </button>
        </div>
      </div>
    );
  }

  const trashedBy = crumbs.find((c) => c.deletedAt);
  const isDb = page.kind === "database";
  const wide = mode === "full" && (isDb || page.fullWidth);
  const rowSchema = page.isRow ? (parent?.schema ?? []) : [];
  const locked = !!page.locked;
  const blank = !isDb && !locked && isBlank(page.content);

  const pickCoverImage = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (f) await updatePage(page.id, { cover: await saveFile(f) });
    };
    input.click();
  };

  const applyTemplate = (t: Template) => {
    const editor = editorRef.current;
    if (!editor) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    editor.replaceBlocks(editor.document, t.blocks() as any);
    void updatePage(page.id, {
      ...(page.title ? {} : { title: t.title() }),
      ...(page.icon ? {} : { icon: t.icon }),
    });
  };

  const moveToTrash = () => {
    void trashPage(page.id);
    toast(`已將「${page.title || "未命名"}」移到垃圾桶`, { label: "復原", run: () => void restorePage(page.id) });
    if (mode === "peek") peek.close();
  };

  const coverMenu = (close: () => void) => (
    <div className="menu">
      <div className="swatches">
        {Object.entries(COVERS).map(([key, bg]) => (
          <button
            key={key}
            className="swatch"
            style={{ backgroundImage: bg }}
            aria-label={"封面 " + key.slice(5)}
            onClick={() => {
              void updatePage(page.id, { cover: key });
              close();
            }}
          />
        ))}
      </div>
      <MenuItem
        icon={<ImageIcon size={14} />}
        onClick={() => {
          pickCoverImage();
          close();
        }}
      >
        上傳圖片
      </MenuItem>
      {page.cover && (
        <MenuItem
          danger
          icon={<Trash2 size={14} />}
          onClick={() => {
            void updatePage(page.id, { cover: undefined });
            close();
          }}
        >
          移除封面
        </MenuItem>
      )}
    </div>
  );

  const chars = (page.text ?? "").replace(/\s/g, "").length;

  return (
    <div className={"page-shell" + (mode === "peek" ? " in-peek" : "")}>
      <header className="topbar">
        {mode === "peek" ? (
          <>
            <button className="icon-btn" title="關閉（Esc）" onClick={() => peek.close()}>
              <ChevronsRight size={16} />
            </button>
            <button className="btn ghost small" onClick={() => openPage(page.id)}>
              <Maximize2 size={13} /> 整頁開啟
            </button>
          </>
        ) : (
          <>
            {sidebarHidden && (
              <button className="icon-btn" title="顯示側邊欄（Ctrl + \）" onClick={onShowSidebar}>
                <PanelLeftOpen size={16} />
              </button>
            )}
            <nav className="crumbs" aria-label="路徑">
              {crumbs.map((c, i) => (
                <span key={c.id} className="crumb">
                  {i > 0 && <ChevronRight size={12} className="faint" />}
                  <button onClick={() => openPage(c.id)} aria-current={i === crumbs.length - 1 ? "page" : undefined}>
                    {pageIcon(c)} {c.title || "未命名"}
                  </button>
                </span>
              ))}
            </nav>
          </>
        )}
        <span className="spacer" />
        {locked && (
          <button className="btn ghost small" title="點一下解除鎖定" onClick={() => void updatePage(page.id, { locked: false })}>
            <Lock size={13} /> 已鎖定
          </button>
        )}
        <span className="edited muted">編輯於 {dayjs(page.updatedAt).format("M/D HH:mm")}</span>
        <button
          className={"icon-btn" + (page.favorite ? " starred" : "")}
          title={page.favorite ? "從最愛移除" : "加入最愛"}
          aria-pressed={!!page.favorite}
          onClick={() => void updatePage(page.id, { favorite: !page.favorite })}
        >
          <Star size={16} fill={page.favorite ? "currentColor" : "none"} />
        </button>
        <Popover
          align="end"
          width={220}
          trigger={(p) => (
            <button className="icon-btn" title="頁面選單" {...p}>
              <MoreHorizontal size={16} />
            </button>
          )}
        >
          {(close) => (
            <div className="menu">
              {!isDb && (
                <>
                  <div className="font-pick">
                    {(["default", "serif", "mono"] as const).map((f) => (
                      <button
                        key={f}
                        className={"font-" + f + ((page.font ?? "default") === f ? " active" : "")}
                        onClick={() => void updatePage(page.id, { font: f })}
                      >
                        <b>Ag</b>
                        {{ default: "預設", serif: "襯線", mono: "等寬" }[f]}
                      </button>
                    ))}
                  </div>
                  <MenuItem
                    icon={<Type size={14} />}
                    active={!!page.smallText}
                    onClick={() => void updatePage(page.id, { smallText: !page.smallText })}
                  >
                    小字
                  </MenuItem>
                </>
              )}
              {!isDb && mode === "full" && (
                <MenuItem
                  icon={<MoveHorizontal size={14} />}
                  active={!!page.fullWidth}
                  onClick={() => void updatePage(page.id, { fullWidth: !page.fullWidth })}
                >
                  全寬顯示
                </MenuItem>
              )}
              {!isDb && (
                <MenuItem
                  icon={locked ? <Unlock size={14} /> : <Lock size={14} />}
                  onClick={() => {
                    void updatePage(page.id, { locked: !locked });
                    close();
                  }}
                >
                  {locked ? "解除鎖定" : "鎖定頁面"}
                </MenuItem>
              )}
              {!isDb && (
                <MenuItem
                  icon={<History size={14} />}
                  onClick={() => {
                    setDialog("history");
                    close();
                  }}
                >
                  版本歷史
                </MenuItem>
              )}
              {!page.isRow && (
                <MenuItem
                  icon={<CornerUpRight size={14} />}
                  onClick={() => {
                    setDialog("move");
                    close();
                  }}
                >
                  移動到…
                </MenuItem>
              )}
              <MenuItem
                icon={<Download size={14} />}
                onClick={() => {
                  close();
                  if (isDb) return void exportCsv(page);
                  const md = editorRef.current?.blocksToMarkdownLossy() ?? "";
                  download(safeName(page.title) + ".md", `# ${page.title}\n\n${md}`, "text/markdown");
                }}
              >
                {isDb ? "匯出 CSV" : "匯出 Markdown"}
              </MenuItem>
              {isDb && (
                <MenuItem
                  icon={<Upload size={14} />}
                  onClick={() => {
                    close();
                    const input = document.createElement("input");
                    input.type = "file";
                    input.accept = ".csv,text/csv";
                    input.onchange = async () => {
                      const f = input.files?.[0];
                      if (!f) return;
                      const n = await importCsv(page.id, await f.text());
                      toast(n ? `已匯入 ${n} 筆` : "這個檔案沒有可匯入的資料（需要標題列加上至少一列）");
                    };
                    input.click();
                  }}
                >
                  匯入 CSV
                </MenuItem>
              )}
              <MenuItem
                icon={<Printer size={14} />}
                onClick={() => {
                  close();
                  setTimeout(() => window.print(), 50);
                }}
              >
                列印／存成 PDF
              </MenuItem>
              <MenuItem
                icon={<Copy size={14} />}
                onClick={async () => {
                  close();
                  const copy = await duplicatePage(page.id);
                  if (copy) openPage(copy);
                }}
              >
                建立副本
              </MenuItem>
              <MenuItem
                danger
                icon={<Trash2 size={14} />}
                onClick={() => {
                  close();
                  moveToTrash();
                }}
              >
                移到垃圾桶
              </MenuItem>
              <div className="menu-sep" />
              <div className="hint">
                {!isDb && <>字數 {chars}　</>}
                建立於 {dayjs(page.createdAt).format("YYYY/M/D")}
              </div>
            </div>
          )}
        </Popover>
      </header>

      {trashedBy && (
        <div className="banner" role="status">
          {trashedBy.id === page.id ? "這個頁面在垃圾桶裡。" : `上層頁面「${trashedBy.title || "未命名"}」在垃圾桶裡。`}
          <button className="btn small" onClick={() => void restorePage(trashedBy.id)}>
            還原
          </button>
          {trashedBy.id === page.id && (
            <button
              className="btn small danger"
              onClick={() => {
                if (confirm("永久刪除這個頁面與它底下的所有內容？此動作無法復原。")) {
                  void deletePageForever(page.id);
                  if (mode === "peek") peek.close();
                  else navigate("/");
                }
              }}
            >
              永久刪除
            </button>
          )}
        </div>
      )}

      <div className="page-scroll" ref={scrollRef}>
        {coverStyle && (
          <div className="cover" style={coverStyle}>
            <Popover align="end" width={220} trigger={(p) => <button className="btn small cover-btn" {...p}>更換封面</button>}>
              {coverMenu}
            </Popover>
          </div>
        )}
        <div
          className={
            "page-body" +
            (wide ? " wide" : "") +
            (page.font && page.font !== "default" ? " font-" + page.font : "") +
            (page.smallText ? " small-text" : "")
          }
        >
          <div className={"page-head" + (coverStyle ? " has-cover" : "")}>
            {page.icon && (
              <Popover
                trigger={(p) => (
                  <button className="page-icon" aria-label="更換圖示" {...p}>
                    {page.icon}
                  </button>
                )}
              >
                {(close) => (
                  <EmojiPicker
                    onPick={(icon) => {
                      void updatePage(page.id, { icon });
                      close();
                    }}
                    onRemove={() => {
                      void updatePage(page.id, { icon: undefined });
                      close();
                    }}
                  />
                )}
              </Popover>
            )}
            <div className="head-actions">
              {!page.icon && (
                <Popover
                  trigger={(p) => (
                    <button className="btn ghost small" {...p}>
                      <Smile size={14} /> 加入圖示
                    </button>
                  )}
                >
                  {(close) => (
                    <EmojiPicker
                      onPick={(icon) => {
                        void updatePage(page.id, { icon });
                        close();
                      }}
                    />
                  )}
                </Popover>
              )}
              {!page.cover && (
                <Popover
                  width={220}
                  trigger={(p) => (
                    <button className="btn ghost small" {...p}>
                      <ImageIcon size={14} /> 加入封面
                    </button>
                  )}
                >
                  {coverMenu}
                </Popover>
              )}
            </div>
            <LiveInput
              key={page.id}
              className="page-title"
              value={page.title}
              placeholder="未命名"
              aria-label="頁面標題"
              autoFocus={!page.title && isBlank(page.content)}
              onSave={(title) => void updatePage(page.id, { title })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  editorRef.current?.focus();
                }
              }}
            />
            {linkedFrom.length > 0 && (
              <Popover
                width={280}
                trigger={(p) => (
                  <button className="btn ghost small backlinks" {...p}>
                    <Link2 size={13} /> {linkedFrom.length} 個反向連結
                  </button>
                )}
              >
                {(close) => (
                  <div className="menu">
                    <div className="hint">連結到這一頁的頁面</div>
                    {linkedFrom.map((b) => (
                      <MenuItem
                        key={b.id}
                        icon={pageIcon(b)}
                        onClick={() => {
                          openPage(b.id);
                          close();
                        }}
                      >
                        {b.title || "未命名"}
                      </MenuItem>
                    ))}
                  </div>
                )}
              </Popover>
            )}
          </div>

          {page.isRow && rowSchema.length > 0 && (
            <div className="row-props">
              {rowSchema.map((p) => (
                <div key={p.id} className="row-prop">
                  <span className="row-prop-name">{p.name}</span>
                  <PropCell
                    prop={p}
                    row={page}
                    schema={rowSchema}
                    titles={related}
                    onChange={(v) => void setRowProp(page.id, p.id, v)}
                    onProp={(patch) =>
                      parent &&
                      void mutatePage(parent.id, (cur) => ({
                        schema: (cur.schema ?? []).map((x) => (x.id === p.id ? { ...x, ...patch } : x)),
                      }))
                    }
                  />
                </div>
              ))}
            </div>
          )}

          {isDb ? (
            <DatabaseView dbPage={page} />
          ) : (
            <>
              <Editor
                key={page.id + ":" + restored.n}
                pageId={page.id}
                initialContent={restored.content ?? page.content}
                dark={dark}
                editable={!locked && !trashedBy}
                onReady={(e) => (editorRef.current = e)}
              />
              {blank && (
                <div className="templates">
                  <span className="muted">從範本開始：</span>
                  {TEMPLATES.map((t) => (
                    <button key={t.id} className="btn small" onClick={() => applyTemplate(t)}>
                      {t.icon} {t.name}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {mode === "full" && !isDb && outline.length >= 2 && (
        <nav className="outline" aria-label="大綱">
          <div className="outline-ticks" aria-hidden>
            {outline.slice(0, 24).map((o) => (
              <span key={o.id} className={"l" + o.level} />
            ))}
          </div>
          <div className="outline-list">
            {outline.map((o) => (
              <button
                key={o.id}
                className={"l" + o.level}
                onClick={() =>
                  scrollRef.current
                    ?.querySelector(`[data-id="${CSS.escape(o.id)}"]`)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
              >
                {o.text}
              </button>
            ))}
          </div>
        </nav>
      )}

      {dialog === "history" && (
        <HistoryModal
          page={page}
          onClose={() => setDialog(null)}
          onRestored={(content) => {
            setRestored((r) => ({ n: r.n + 1, content }));
            setDialog(null);
            toast("已還原到所選版本");
          }}
        />
      )}
      {dialog === "move" && <MoveModal page={page} onClose={() => setDialog(null)} />}
    </div>
  );
}

function HistoryModal({
  page,
  onClose,
  onRestored,
}: {
  page: Page;
  onClose: () => void;
  onRestored: (content: unknown[]) => void;
}) {
  const snaps =
    useLiveQuery(async () => (await db.history.where("pageId").equals(page.id).sortBy("at")).reverse(), [page.id]) ?? [];
  const [sel, setSel] = useState<string | null>(null);
  const current = snaps.find((s) => s.id === sel) ?? snaps[0];
  return (
    <Modal onClose={onClose} className="history" label="版本歷史">
      <div className="history-list">
        <h2>版本歷史</h2>
        {snaps.length === 0 && (
          <p className="hint">還沒有舊版本。編輯時每 10 分鐘會自動留存一份，最多保留 40 份。</p>
        )}
        {snaps.map((s) => (
          <button
            key={s.id}
            className={"menu-item" + (s.id === current?.id ? " active" : "")}
            onClick={() => setSel(s.id)}
          >
            <span className="menu-label">{dayjs(s.at).format("M 月 D 日 HH:mm")}</span>
          </button>
        ))}
      </div>
      <div className="history-preview">
        {current ? (
          <>
            <div className="history-text">{blocksToText(current.content) || "（空白）"}</div>
            <div className="modal-foot">
              <button className="btn" onClick={onClose}>
                取消
              </button>
              <button
                className="btn primary"
                onClick={async () => {
                  await restoreSnapshot(current.id);
                  onRestored(current.content);
                }}
              >
                還原這個版本
              </button>
            </div>
          </>
        ) : (
          <div className="modal-foot">
            <button className="btn" onClick={onClose}>
              關閉
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function MoveModal({ page, onClose }: { page: Page; onClose: () => void }) {
  const [q, setQ] = useState("");
  const pages =
    useLiveQuery(
      async () => (await db.pages.toArray()).filter((p) => p.kind === "page" && !p.isRow && !p.deletedAt),
      [],
    ) ?? [];
  const term = q.trim().toLowerCase();
  const shown = pages
    .filter((p) => p.id !== page.id && p.id !== page.parentId && p.title.toLowerCase().includes(term))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 30);
  const go = async (target: string | null, name: string) => {
    const before = (await db.pages.get(page.id))?.parentId;
    await movePage(page.id, target);
    const after = (await db.pages.get(page.id))?.parentId;
    if (before === after) toast("無法移到自己的子頁面底下");
    else toast(`已移動到「${name}」`);
    onClose();
  };
  return (
    <Modal onClose={onClose} className="search" label="移動頁面">
      <input
        autoFocus
        className="search-input"
        placeholder={`把「${page.title || "未命名"}」移動到…`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="search-results">
        {page.parentId && !term && (
          <button className="search-row" onClick={() => void go(null, "最上層")}>
            <span className="nav-icon">🏠</span>
            <span className="search-title">最上層</span>
          </button>
        )}
        {shown.map((p) => (
          <button key={p.id} className="search-row" onClick={() => void go(p.id, p.title || "未命名")}>
            <span className="nav-icon">{pageIcon(p)}</span>
            <span className="search-title">{p.title || "未命名"}</span>
          </button>
        ))}
        {shown.length === 0 && term && <div className="hint">找不到符合的頁面</div>}
      </div>
    </Modal>
  );
}
