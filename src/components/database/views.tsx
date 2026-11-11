import { useRef, useState } from "react";
import dayjs from "dayjs";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { OPTION_COLORS, updatePage } from "../../db";
import { cellValue, displayValue, today, uid } from "../../lib/logic";
import type { Page, Property } from "../../types";
import { PropCell, Tag } from "./PropCell";
import { type Ctx, useCoverStyle } from "./shared";



// ---------- cards ----------

function CardProps({ row, ctx, skip }: { row: Page; ctx: Ctx; skip?: string }) {
  const parts = ctx.visible
    .filter((p) => p.id !== skip)
    .map((p) => {
      const v = cellValue(row, p.id, ctx.schema, ctx.titles);
      if (v === null || v === undefined || v === "" || v === false) return null;
      if (Array.isArray(v) && v.length === 0) return null;
      if (p.options) {
        const ids = Array.isArray(v) ? v : [String(v)];
        return ids.map((id) => {
          const o = p.options!.find((x) => x.id === id);
          return o ? <Tag key={p.id + id} option={o} /> : null;
        });
      }
      if (p.type === "checkbox") {
        return (
          <span key={p.id} className="card-meta">
            ✓ {p.name}
          </span>
        );
      }
      const text = displayValue(v, p, ctx.titles);
      if (!text || text.startsWith("#")) return null;
      return (
        <span key={p.id} className="card-meta" title={p.name}>
          {text}
        </span>
      );
    });
  return <div className="card-props">{parts}</div>;
}

const NeedProp = ({
  text,
  has,
  onUse,
  type,
}: {
  text: string;
  has: boolean;
  onUse: () => void;
  type: string;
}) => (
  <div className="empty">
    <p>{text}</p>
    <button className="btn primary" onClick={onUse}>
      {has ? `使用現有的${type}屬性` : `建立${type}屬性`}
    </button>
  </div>
);

// ---------- board ----------

export function BoardView({ ctx }: { ctx: Ctx }) {
  const { schema, rows, view } = ctx;
  const [over, setOver] = useState<string | null>(null);
  const group = schema.find((p) => p.id === view.groupBy && p.type === "select");
  if (!group) {
    const existing = schema.find((p) => p.type === "select");
    return (
      <NeedProp
        text="看板需要一個「單選」屬性來分欄。"
        type="單選"
        has={!!existing}
        onUse={() => ctx.patchView({ groupBy: (existing ?? ctx.addProp("select")).id })}
      />
    );
  }
  const columns = [...(group.options ?? []), { id: "", name: "未分類", color: "gray" }];
  return (
    <div className="board">
      {columns.map((col) => {
        const cards = rows.filter((r) => ((r.props?.[group.id] as string) || "") === col.id);
        if (col.id === "" && cards.length === 0 && columns.length > 1) return null;
        return (
          <div
            key={col.id}
            className={"board-col" + (over === col.id ? " over" : "")}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(col.id);
            }}
            onDragLeave={() => setOver((o) => (o === col.id ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData("text/row");
              if (id) ctx.setProp(id, group.id, col.id || null);
            }}
          >
            <div className="board-head">
              <Tag option={col} />
              <span className="muted">{cards.length}</span>
            </div>
            {cards.map((r) => (
              <button
                key={r.id}
                className="card"
                draggable
                onDragStart={(e) => e.dataTransfer.setData("text/row", r.id)}
                onClick={() => ctx.openRow(r.id)}
              >
                <span className="card-title">
                  {r.icon} {r.title || "未命名"}
                </span>
                <CardProps row={r} ctx={ctx} skip={group.id} />
              </button>
            ))}
            <button
              className="add-row"
              onClick={async () => ctx.openRow(await ctx.addRow({ [group.id]: col.id || null }))}
            >
              <Plus size={14} /> 新增
            </button>
          </div>
        );
      })}
      <form
        className="board-col new"
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem("name") as HTMLInputElement;
          const name = input.value.trim();
          if (!name || (group.options ?? []).some((o) => o.name === name)) return;
          ctx.patchProp(group.id, {
            options: [
              ...(group.options ?? []),
              { id: uid(), name, color: OPTION_COLORS[(group.options ?? []).length % OPTION_COLORS.length] },
            ],
          });
          input.value = "";
        }}
      >
        <input name="name" className="input" placeholder="＋ 新增分組" aria-label="新增分組" />
      </form>
    </div>
  );
}

// ---------- list ----------

export function ListView({ ctx }: { ctx: Ctx }) {
  return (
    <div className="db-list">
      {ctx.rows.map((r) => (
        <button key={r.id} className="db-list-row" onClick={() => ctx.openRow(r.id)}>
          <span className="card-title">
            {r.icon ?? "📄"} {r.title || "未命名"}
          </span>
          <CardProps row={r} ctx={ctx} />
        </button>
      ))}
      <button className="add-row" onClick={async () => ctx.openRow(await ctx.addRow())}>
        <Plus size={14} /> 新增
      </button>
    </div>
  );
}

// ---------- gallery ----------

function GalleryCard({ row, ctx }: { row: Page; ctx: Ctx }) {
  const cover = useCoverStyle(row.cover);
  return (
    <button className="gallery-card" onClick={() => ctx.openRow(row.id)}>
      <div className="gallery-cover" style={cover ?? undefined}>
        {!cover && <span>{row.icon ?? "📄"}</span>}
      </div>
      <div className="gallery-body">
        <span className="card-title">
          {cover && row.icon} {row.title || "未命名"}
        </span>
        <CardProps row={row} ctx={ctx} />
      </div>
    </button>
  );
}

export function GalleryView({ ctx }: { ctx: Ctx }) {
  return (
    <div className="gallery">
      {ctx.rows.map((r) => (
        <GalleryCard key={r.id} row={r} ctx={ctx} />
      ))}
      <button className="gallery-card add" onClick={async () => ctx.openRow(await ctx.addRow())}>
        <Plus size={16} /> 新增
      </button>
    </div>
  );
}

// ---------- calendar ----------

export function monthGrid(month: dayjs.Dayjs): dayjs.Dayjs[] {
  const start = month.startOf("month").startOf("week");
  const weeks = Math.ceil((month.startOf("month").day() + month.daysInMonth()) / 7);
  return Array.from({ length: weeks * 7 }, (_, i) => start.add(i, "day"));
}

function MonthNav({
  label,
  onPrev,
  onNext,
  onToday,
  extra,
}: {
  label: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  extra?: React.ReactNode;
}) {
  return (
    <div className="cal-head">
      <strong>{label}</strong>
      <span className="spacer" />
      {extra}
      <button className="icon-btn" title="往前" onClick={onPrev}>
        <ChevronLeft size={16} />
      </button>
      <button className="btn ghost small" onClick={onToday}>
        今天
      </button>
      <button className="icon-btn" title="往後" onClick={onNext}>
        <ChevronRight size={16} />
      </button>
    </div>
  );
}

function useDateProp(ctx: Ctx, what: string): Property | JSX.Element {
  const { schema, view } = ctx;
  const dateProp = schema.find((p) => p.id === view.dateProp && p.type === "date");
  if (dateProp) return dateProp;
  const existing = schema.find((p) => p.type === "date");
  return (
    <NeedProp
      text={`${what}需要一個「日期」屬性。`}
      type="日期"
      has={!!existing}
      onUse={() => ctx.patchView({ dateProp: (existing ?? ctx.addProp("date")).id })}
    />
  );
}

export function CalendarView({ ctx }: { ctx: Ctx }) {
  const { rows } = ctx;
  const [month, setMonth] = useState(() => dayjs().startOf("month"));
  const dateProp = useDateProp(ctx, "月曆");
  if (!("id" in dateProp)) return dateProp;
  const byDay = new Map<string, Page[]>();
  for (const r of rows) {
    const d = r.props?.[dateProp.id];
    if (typeof d === "string" && d) byDay.set(d, [...(byDay.get(d) ?? []), r]);
  }
  const undated = rows.filter((r) => !r.props?.[dateProp.id]).length;
  return (
    <div className="calendar">
      <MonthNav
        label={month.format("YYYY 年 M 月")}
        onPrev={() => setMonth(month.subtract(1, "month"))}
        onNext={() => setMonth(month.add(1, "month"))}
        onToday={() => setMonth(dayjs().startOf("month"))}
        extra={undated > 0 && <span className="muted">{undated} 筆未設定日期</span>}
      />
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
              className={
                "cal-day" + (d.month() !== month.month() ? " other" : "") + (key === today() ? " today" : "")
              }
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/row");
                if (id) ctx.setProp(id, dateProp.id, key);
              }}
            >
              <div className="cal-num">
                <span>{d.date()}</span>
                <button
                  className="icon-btn cal-add"
                  title={`在 ${key} 新增`}
                  onClick={async () => ctx.openRow(await ctx.addRow({ [dateProp.id]: key }))}
                >
                  <Plus size={12} />
                </button>
              </div>
              {(byDay.get(key) ?? []).map((r) => (
                <button
                  key={r.id}
                  className="cal-item"
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/row", r.id)}
                  onClick={() => ctx.openRow(r.id)}
                >
                  {r.icon} {r.title || "未命名"}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- timeline ----------

const DAY_W = 34;
const SPAN = 42;

export function TimelineView({ ctx }: { ctx: Ctx }) {
  const { rows, schema, view } = ctx;
  const [start, setStart] = useState(() => dayjs().startOf("week").subtract(7, "day"));
  const [shift, setShift] = useState<{ id: string; days: number } | null>(null);
  const moved = useRef(false);
  const dateProp = useDateProp(ctx, "時間軸");
  if (!("id" in dateProp)) return dateProp;
  const endProp = schema.find((p) => p.id === view.endProp && p.type === "date");
  const days = Array.from({ length: SPAN }, (_, i) => start.add(i, "day"));
  const t0 = today();

  const range = (r: Page) => {
    const s = r.props?.[dateProp.id];
    if (typeof s !== "string" || !s) return null;
    const e = endProp ? r.props?.[endProp.id] : null;
    const end = typeof e === "string" && e && e >= s ? e : s;
    return { s, e: end };
  };

  const beginDrag = (r: Page, ev: React.PointerEvent) => {
    const rg = range(r);
    if (!rg) return;
    const x0 = ev.clientX;
    moved.current = false;
    let d = 0;
    const move = (e: PointerEvent) => {
      d = Math.round((e.clientX - x0) / DAY_W);
      if (d !== 0) moved.current = true;
      setShift({ id: r.id, days: d });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setShift(null);
      if (d === 0) return;
      const add = (v: string) => dayjs(v).add(d, "day").format("YYYY-MM-DD");
      void updatePage(r.id, {
        props: {
          ...r.props,
          [dateProp.id]: add(rg.s),
          ...(endProp && r.props?.[endProp.id] ? { [endProp.id]: add(rg.e) } : {}),
        },
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="calendar">
      <MonthNav
        label={`${start.format("YYYY 年 M 月 D 日")} – ${start.add(SPAN - 1, "day").format("M 月 D 日")}`}
        onPrev={() => setStart(start.subtract(14, "day"))}
        onNext={() => setStart(start.add(14, "day"))}
        onToday={() => setStart(dayjs().startOf("week").subtract(7, "day"))}
        extra={!endProp && <span className="muted">在工具列選「結束」屬性可顯示跨日長條</span>}
      />
      <div className="timeline">
        <div className="tl-grid" style={{ width: 220 + SPAN * DAY_W }}>
          <div className="tl-row tl-head">
            <div className="tl-name" />
            {days.map((d) => (
              <div
                key={d.valueOf()}
                className={
                  "tl-day" +
                  (d.format("YYYY-MM-DD") === t0 ? " today" : "") +
                  (d.day() === 0 || d.day() === 6 ? " weekend" : "")
                }
                style={{ width: DAY_W }}
              >
                {d.date() === 1 || d.isSame(start, "day") ? <small>{d.format("M月")}</small> : <small>&nbsp;</small>}
                {d.date()}
              </div>
            ))}
          </div>
          {rows.map((r) => {
            const rg = range(r);
            const off = shift?.id === r.id ? shift.days : 0;
            const left = rg ? (dayjs(rg.s).diff(start, "day") + off) * DAY_W : 0;
            const w = rg ? (dayjs(rg.e).diff(dayjs(rg.s), "day") + 1) * DAY_W : 0;
            return (
              <div key={r.id} className="tl-row">
                <button className="tl-name" onClick={() => ctx.openRow(r.id)}>
                  {r.icon} {r.title || "未命名"}
                </button>
                <div className="tl-track" style={{ width: SPAN * DAY_W, backgroundSize: `${DAY_W}px 100%` }}>
                  {rg && w < DAY_W * 3 && (
                    <span className="tl-label" style={{ left: left + w + 4 }}>
                      {r.title || "未命名"}
                    </span>
                  )}
                  {rg ? (
                    <button
                      className="tl-bar"
                      style={{ left, width: w - 4 }}
                      title={`${rg.s}${rg.e !== rg.s ? " → " + rg.e : ""}（可左右拖曳）`}
                      onPointerDown={(e) => beginDrag(r, e)}
                      onClick={() => !moved.current && ctx.openRow(r.id)}
                    >
                      {w >= DAY_W * 3 && (r.title || "未命名")}
                    </button>
                  ) : (
                    <button
                      className="tl-unset"
                      onClick={() => ctx.setProp(r.id, dateProp.id, t0)}
                    >
                      設為今天
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <button className="add-row" onClick={async () => ctx.openRow(await ctx.addRow({ [dateProp.id]: t0 }))}>
        <Plus size={14} /> 新增
      </button>
    </div>
  );
}
