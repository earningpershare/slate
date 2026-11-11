import { useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Calendar,
  Columns3,
  Eye,
  EyeOff,
  Filter as FilterIcon,
  GanttChart,
  LayoutGrid,
  List,
  MoreHorizontal,
  Plus,
  Search,
  SlidersHorizontal,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { createPage, db, mutatePage, setRowProp } from "../../db";
import { COMPUTED, applyView, convertValue, uid } from "../../lib/logic";
import { peek } from "../../stores";
import type { DbView, Filter, FilterOp, Page, Property, PropType, PropValue, ViewType } from "../../types";
import { CommitInput, MenuItem, Popover, useLocalState } from "../../ui";
import { type Ctx, TYPE_LABEL, useRelated } from "./shared";
import { TableView } from "./TableView";
import { BoardView, CalendarView, GalleryView, ListView, TimelineView } from "./views";

export { monthGrid } from "./views";

const VIEW_META: Record<ViewType, { label: string; icon: JSX.Element }> = {
  table: { label: "表格", icon: <Table2 size={14} /> },
  board: { label: "看板", icon: <Columns3 size={14} /> },
  list: { label: "清單", icon: <List size={14} /> },
  calendar: { label: "月曆", icon: <Calendar size={14} /> },
  gallery: { label: "畫廊", icon: <LayoutGrid size={14} /> },
  timeline: { label: "時間軸", icon: <GanttChart size={14} /> },
};

const OP_LABEL: Record<FilterOp, string> = {
  contains: "包含",
  notContains: "不包含",
  eq: "等於",
  neq: "不等於",
  gt: "大於／晚於",
  lt: "小於／早於",
  empty: "為空",
  notEmpty: "不為空",
  checked: "已勾選",
  unchecked: "未勾選",
};

function opsFor(type: PropType | "title"): FilterOp[] {
  switch (type) {
    case "checkbox":
      return ["checked", "unchecked"];
    case "number":
    case "date":
    case "createdTime":
    case "updatedTime":
      return ["eq", "neq", "gt", "lt", "empty", "notEmpty"];
    case "select":
      return ["eq", "neq", "empty", "notEmpty"];
    case "formula":
    case "rollup":
      return ["contains", "eq", "neq", "gt", "lt", "empty", "notEmpty"];
    default:
      return ["contains", "notContains", "eq", "neq", "empty", "notEmpty"];
  }
}

const NO_VALUE_OPS: FilterOp[] = ["empty", "notEmpty", "checked", "unchecked"];

export default function DatabaseView({ dbPage, inline = false }: { dbPage: Page; inline?: boolean }) {
  const schema = dbPage.schema ?? [];
  const views = dbPage.views ?? [];
  const [viewId, setViewId] = useLocalState<string>("view:" + dbPage.id, "");
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const view = views.find((v) => v.id === viewId) ?? views[0];

  const allRows = useLiveQuery(
    () => db.pages.where("parentId").equals(dbPage.id).toArray(),
    [dbPage.id],
  );
  const titles = useRelated(schema);
  const rows = useMemo(
    () =>
      view
        ? applyView((allRows ?? []).filter((r) => r.isRow && !r.deletedAt), view, schema, titles, search)
        : [],
    [allRows, view, schema, titles, search],
  );

  // All edits go through mutatePage so they apply to the latest stored value.
  const editSchema = (fn: (schema: Property[]) => Property[]) =>
    void mutatePage(dbPage.id, (cur) => ({ schema: fn(cur.schema ?? []) }));
  const editViews = (fn: (views: DbView[]) => DbView[]) =>
    void mutatePage(dbPage.id, (cur) => ({ views: fn(cur.views ?? []) }));

  if (!view) return null;
  const hidden = view.hidden ?? [];

  const ctx: Ctx = {
    dbPage,
    schema,
    visible: schema.filter((p) => !hidden.includes(p.id)),
    rows,
    view,
    titles,
    inline,
    openRow: peek.open,
    setProp: (rowId, propId, v) => void setRowProp(rowId, propId, v),
    patchProp: (propId, patch) => editSchema((s) => s.map((p) => (p.id === propId ? { ...p, ...patch } : p))),
    patchView: (patch) => editViews((vs) => vs.map((v) => (v.id === view.id ? { ...v, ...patch } : v))),
    addRow: (props = {}) => {
      // New rows satisfy the active "equals" filters so they don't vanish on creation.
      const preset: Record<string, PropValue> = {};
      for (const f of view.filters) {
        const prop = schema.find((p) => p.id === f.propId);
        if (f.op === "checked") preset[f.propId] = true;
        if (f.op === "eq" && prop?.type === "select") {
          const opt = prop.options?.find((o) => o.name === f.value);
          if (opt) preset[f.propId] = opt.id;
        }
      }
      return createPage(dbPage.id, { isRow: true, props: { ...preset, ...props } });
    },
    changeType: (prop, type) => {
      if (prop.type === type) return;
      const isSel = (t: PropType) => t === "select" || t === "multiSelect";
      const next: Property = {
        ...prop,
        type,
        options: isSel(type) ? (prop.options ?? []) : undefined,
        relationDb: type === "relation" ? prop.relationDb : undefined,
        formula: type === "formula" ? (prop.formula ?? "") : undefined,
        rollupRel: type === "rollup" ? prop.rollupRel : undefined,
        rollupProp: type === "rollup" ? prop.rollupProp : undefined,
        rollupCalc: type === "rollup" ? prop.rollupCalc : undefined,
      };
      void db.transaction("rw", db.pages, async () => {
        for (const r of allRows ?? []) {
          if (r.props && prop.id in r.props) {
            await db.pages.update(r.id, {
              props: { ...r.props, [prop.id]: convertValue(r.props[prop.id], prop, type) },
            });
          }
        }
        const cur = await db.pages.get(dbPage.id);
        await db.pages.update(dbPage.id, {
          schema: (cur?.schema ?? []).map((p) => (p.id === prop.id ? next : p)),
          updatedAt: Date.now(),
        });
      });
    },
    deleteProp: (propId) =>
      void mutatePage(dbPage.id, (cur) => ({
        schema: (cur.schema ?? []).filter((p) => p.id !== propId),
        views: (cur.views ?? []).map((v) => ({
          ...v,
          filters: v.filters.filter((f) => f.propId !== propId),
          sorts: v.sorts.filter((s) => s.propId !== propId),
          hidden: v.hidden?.filter((h) => h !== propId),
          groupBy: v.groupBy === propId ? undefined : v.groupBy,
          dateProp: v.dateProp === propId ? undefined : v.dateProp,
          endProp: v.endProp === propId ? undefined : v.endProp,
        })),
      })),
    moveProp: (propId, dir) =>
      editSchema((s) => {
        const i = s.findIndex((p) => p.id === propId);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= s.length) return s;
        const next = [...s];
        [next[i], next[j]] = [next[j], next[i]];
        return next;
      }),
    addProp: (type) => {
      const p: Property = { id: uid(), name: TYPE_LABEL[type], type };
      if (type === "select" || type === "multiSelect") p.options = [];
      editSchema((s) => [...s, p]);
      return p;
    },
  };

  const addView = (type: ViewType) => {
    const v: DbView = { id: uid(), name: VIEW_META[type].label, type, filters: [], sorts: [] };
    if (type === "board") v.groupBy = schema.find((p) => p.type === "select")?.id;
    if (type === "calendar" || type === "timeline") v.dateProp = schema.find((p) => p.type === "date")?.id;
    editViews((vs) => [...vs, v]);
    setViewId(v.id);
  };

  const dates = schema.filter((p) => p.type === "date");

  return (
    <div className={"database" + (inline ? " inline" : "")}>
      <div className="db-bar">
        <div className="db-tabs" role="tablist">
          {views.map((v) => (
            <span key={v.id} className={"db-tab" + (v.id === view.id ? " active" : "")}>
              <button role="tab" aria-selected={v.id === view.id} onClick={() => setViewId(v.id)}>
                {VIEW_META[v.type].icon}
                {v.name}
              </button>
              {v.id === view.id && (
                <Popover
                  width={220}
                  trigger={(p) => (
                    <button className="icon-btn" title="檢視設定" {...p}>
                      <MoreHorizontal size={14} />
                    </button>
                  )}
                >
                  {(close) => (
                    <div className="menu">
                      <CommitInput
                        className="input"
                        value={v.name}
                        aria-label="檢視名稱"
                        onCommit={(name) => ctx.patchView({ name: name.trim() || v.name })}
                      />
                      <MenuItem
                        icon={<Plus size={14} />}
                        onClick={() => {
                          const copy = { ...v, id: uid(), name: v.name + " 副本" };
                          editViews((vs) => [...vs, copy]);
                          setViewId(copy.id);
                          close();
                        }}
                      >
                        複製檢視
                      </MenuItem>
                      {views.length > 1 && (
                        <MenuItem
                          danger
                          icon={<Trash2 size={14} />}
                          onClick={() => {
                            editViews((vs) => vs.filter((x) => x.id !== v.id));
                            close();
                          }}
                        >
                          刪除檢視
                        </MenuItem>
                      )}
                    </div>
                  )}
                </Popover>
              )}
            </span>
          ))}
          <Popover
            width={160}
            trigger={(p) => (
              <button className="icon-btn" title="新增檢視" {...p}>
                <Plus size={15} />
              </button>
            )}
          >
            {(close) => (
              <div className="menu">
                {(Object.keys(VIEW_META) as ViewType[]).map((t) => (
                  <MenuItem
                    key={t}
                    icon={VIEW_META[t].icon}
                    onClick={() => {
                      addView(t);
                      close();
                    }}
                  >
                    {VIEW_META[t].label}
                  </MenuItem>
                ))}
              </div>
            )}
          </Popover>
        </div>
        <div className="db-tools">
          {(view.type === "board" || view.type === "table") && (
            <PropSelect
              label="分組"
              value={view.groupBy}
              props={schema.filter((p) => p.type === "select")}
              allowNone={view.type === "table"}
              onChange={(groupBy) => ctx.patchView({ groupBy: groupBy || undefined })}
            />
          )}
          {(view.type === "calendar" || view.type === "timeline") && (
            <PropSelect
              label={view.type === "timeline" ? "開始" : "日期"}
              value={view.dateProp}
              props={dates}
              onChange={(dateProp) => ctx.patchView({ dateProp })}
            />
          )}
          {view.type === "timeline" && (
            <PropSelect
              label="結束"
              value={view.endProp}
              props={dates.filter((p) => p.id !== view.dateProp)}
              allowNone
              onChange={(endProp) => ctx.patchView({ endProp: endProp || undefined })}
            />
          )}
          {searching ? (
            <span className="db-search">
              <Search size={14} />
              <input
                autoFocus
                value={search}
                placeholder="在這個檢視中搜尋"
                aria-label="在這個檢視中搜尋"
                onChange={(e) => setSearch(e.target.value)}
                onBlur={() => !search && setSearching(false)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearch("");
                    setSearching(false);
                  }
                }}
              />
            </span>
          ) : (
            <button className="icon-btn" title="搜尋" onClick={() => setSearching(true)}>
              <Search size={15} />
            </button>
          )}
          <PropsMenu ctx={ctx} />
          <FilterMenu ctx={ctx} />
          <SortMenu ctx={ctx} />
          <button
            className="btn primary small"
            onClick={async () => {
              const id = await ctx.addRow();
              if (view.type !== "table") ctx.openRow(id);
            }}
          >
            <Plus size={14} /> 新增
          </button>
        </div>
      </div>

      {view.type === "table" && <TableView ctx={ctx} />}
      {view.type === "board" && <BoardView ctx={ctx} />}
      {view.type === "list" && <ListView ctx={ctx} />}
      {view.type === "calendar" && <CalendarView ctx={ctx} />}
      {view.type === "gallery" && <GalleryView ctx={ctx} />}
      {view.type === "timeline" && <TimelineView ctx={ctx} />}
      {search && rows.length === 0 && <div className="hint">沒有符合「{search}」的項目</div>}
    </div>
  );
}

function PropSelect({
  label,
  value,
  props,
  allowNone,
  onChange,
}: {
  label: string;
  value?: string;
  props: Property[];
  allowNone?: boolean;
  onChange: (id: string) => void;
}) {
  if (props.length === 0) return null;
  return (
    <label className="tool-select">
      {label}
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        {(allowNone || !value) && <option value="">{allowNone ? "無" : "選擇…"}</option>}
        {props.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------- properties ----------

function PropsMenu({ ctx }: { ctx: Ctx }) {
  const { schema, view } = ctx;
  const hidden = view.hidden ?? [];
  return (
    <Popover
      align="end"
      width={280}
      trigger={(p) => (
        <button className={"btn ghost small" + (hidden.length ? " on" : "")} {...p}>
          <SlidersHorizontal size={14} /> 屬性
        </button>
      )}
    >
      {() => (
        <div className="menu">
          {schema.length === 0 && <div className="hint">還沒有屬性</div>}
          {schema.map((p, i) => {
            const off = hidden.includes(p.id);
            return (
              <div key={p.id} className="prop-row">
                <span className={"nav-label" + (off ? " muted" : "")}>{p.name}</span>
                <span className="muted small">{TYPE_LABEL[p.type]}</span>
                <button className="icon-btn" title="上移" disabled={i === 0} onClick={() => ctx.moveProp(p.id, -1)}>
                  <ArrowUp size={13} />
                </button>
                <button
                  className="icon-btn"
                  title="下移"
                  disabled={i === schema.length - 1}
                  onClick={() => ctx.moveProp(p.id, 1)}
                >
                  <ArrowDown size={13} />
                </button>
                <button
                  className="icon-btn"
                  title={off ? "顯示" : "隱藏"}
                  aria-pressed={!off}
                  onClick={() =>
                    ctx.patchView({ hidden: off ? hidden.filter((h) => h !== p.id) : [...hidden, p.id] })
                  }
                >
                  {off ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            );
          })}
          <div className="menu-sep" />
          {(Object.keys(TYPE_LABEL) as PropType[]).map((t) => (
            <MenuItem key={t} icon={<Plus size={14} />} onClick={() => ctx.addProp(t)}>
              新增{TYPE_LABEL[t]}
            </MenuItem>
          ))}
        </div>
      )}
    </Popover>
  );
}

// ---------- filter & sort ----------

const columnsOf = (schema: Property[]) => [
  { id: "title", name: "名稱", type: "title" as const },
  ...schema,
];

function FilterMenu({ ctx }: { ctx: Ctx }) {
  const { view, schema, patchView } = ctx;
  const cols = columnsOf(schema);
  const set = (id: string, patch: Partial<Filter>) =>
    patchView({ filters: view.filters.map((f) => (f.id === id ? { ...f, ...patch } : f)) });
  return (
    <Popover
      align="end"
      width={460}
      trigger={(p) => (
        <button className={"btn ghost small" + (view.filters.length ? " on" : "")} {...p}>
          <FilterIcon size={14} /> 篩選{view.filters.length > 0 && ` ${view.filters.length}`}
        </button>
      )}
    >
      {() => (
        <div className="menu rules">
          {view.filters.length === 0 && <div className="hint">尚未設定篩選條件</div>}
          {view.filters.map((f) => {
            const col = cols.find((c) => c.id === f.propId) ?? cols[0];
            const ops = opsFor(col.type);
            return (
              <div key={f.id} className="rule">
                <select
                  value={col.id}
                  aria-label="欄位"
                  onChange={(e) => {
                    const next = cols.find((c) => c.id === e.target.value)!;
                    set(f.id, { propId: next.id, op: opsFor(next.type)[0], value: "" });
                  }}
                >
                  {cols.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <select
                  value={f.op}
                  aria-label="條件"
                  onChange={(e) => set(f.id, { op: e.target.value as FilterOp })}
                >
                  {ops.map((o) => (
                    <option key={o} value={o}>
                      {OP_LABEL[o]}
                    </option>
                  ))}
                </select>
                {NO_VALUE_OPS.includes(f.op) ? (
                  <span />
                ) : col.type === "select" ? (
                  <select
                    value={f.value ?? ""}
                    aria-label="值"
                    onChange={(e) => set(f.id, { value: e.target.value })}
                  >
                    <option value="">選擇…</option>
                    {(col as Property).options?.map((o) => (
                      <option key={o.id} value={o.name}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <CommitInput
                    className="input"
                    aria-label="值"
                    type={col.type === "date" ? "date" : col.type === "number" ? "number" : "text"}
                    value={f.value ?? ""}
                    placeholder="輸入值後按 Enter"
                    onCommit={(value) => set(f.id, { value })}
                  />
                )}
                <button
                  className="icon-btn"
                  title="移除條件"
                  onClick={() => patchView({ filters: view.filters.filter((x) => x.id !== f.id) })}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
          <MenuItem
            icon={<Plus size={14} />}
            onClick={() =>
              patchView({
                filters: [...view.filters, { id: uid(), propId: "title", op: "contains", value: "" }],
              })
            }
          >
            新增條件
          </MenuItem>
        </div>
      )}
    </Popover>
  );
}

function SortMenu({ ctx }: { ctx: Ctx }) {
  const { view, schema, patchView } = ctx;
  const cols = columnsOf(schema);
  return (
    <Popover
      align="end"
      width={320}
      trigger={(p) => (
        <button className={"btn ghost small" + (view.sorts.length ? " on" : "")} {...p}>
          <ArrowUpDown size={14} /> 排序{view.sorts.length > 0 && ` ${view.sorts.length}`}
        </button>
      )}
    >
      {() => (
        <div className="menu rules">
          {view.sorts.length === 0 && <div className="hint">尚未設定排序（可直接拖曳列來手動排序）</div>}
          {view.sorts.map((s, i) => {
            const set = (patch: Partial<typeof s>) =>
              patchView({ sorts: view.sorts.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <div key={i} className="rule sort">
                <select value={s.propId} aria-label="欄位" onChange={(e) => set({ propId: e.target.value })}>
                  {cols.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <select
                  value={s.dir}
                  aria-label="方向"
                  onChange={(e) => set({ dir: e.target.value as "asc" | "desc" })}
                >
                  <option value="asc">遞增</option>
                  <option value="desc">遞減</option>
                </select>
                <button
                  className="icon-btn"
                  title="移除排序"
                  onClick={() => patchView({ sorts: view.sorts.filter((_, j) => j !== i) })}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
          <MenuItem
            icon={<Plus size={14} />}
            onClick={() => patchView({ sorts: [...view.sorts, { propId: "title", dir: "asc" }] })}
          >
            新增排序
          </MenuItem>
        </div>
      )}
    </Popover>
  );
}

// re-exported so callers don't need to know which properties are read-only
export const isComputed = (p: Property) => COMPUTED.includes(p.type);
