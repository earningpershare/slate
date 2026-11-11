import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, ArrowRight, EyeOff, Trash2 } from "lucide-react";
import { db, resolveFileUrl } from "../../db";
import { evalFormula } from "../../lib/formula";
import { FORMULA_FUNCTIONS } from "../../lib/formula";
import type { Titles } from "../../lib/logic";
import type { Calc, DbView, Page, Property, PropType, PropValue } from "../../types";
import { CommitInput, MenuItem } from "../../ui";

export const TYPE_LABEL: Record<PropType, string> = {
  text: "文字",
  number: "數字",
  select: "單選",
  multiSelect: "多選",
  date: "日期",
  checkbox: "核取方塊",
  url: "網址",
  relation: "關聯",
  formula: "公式",
  rollup: "彙總",
  createdTime: "建立時間",
  updatedTime: "上次編輯時間",
};

export const CALC_LABEL: Record<Calc, string> = {
  count: "筆數",
  filled: "已填",
  sum: "加總",
  avg: "平均",
  min: "最小",
  max: "最大",
};

export interface Ctx {
  dbPage: Page;
  schema: Property[];
  /** properties not hidden in the current view */
  visible: Property[];
  rows: Page[];
  view: DbView;
  titles: Titles;
  inline: boolean;
  setProp: (rowId: string, propId: string, v: PropValue) => void;
  patchProp: (propId: string, patch: Partial<Property>) => void;
  patchView: (patch: Partial<DbView>) => void;
  addRow: (props?: Record<string, PropValue>) => Promise<string>;
  openRow: (id: string) => void;
  changeType: (prop: Property, type: PropType) => void;
  deleteProp: (id: string) => void;
  moveProp: (id: string, dir: -1 | 1) => void;
  addProp: (type: PropType) => Property;
}

/** Rows, titles and schemas of the databases this schema links to (for relations and rollups). */
export function useRelated(schema: Property[]): Titles {
  const key = [...new Set(schema.filter((p) => p.type === "relation" && p.relationDb).map((p) => p.relationDb!))]
    .sort()
    .join(",");
  const data = useLiveQuery(async () => {
    if (!key) return null;
    const ids = key.split(",");
    return {
      rows: await db.pages.where("parentId").anyOf(ids).toArray(),
      dbs: (await db.pages.bulkGet(ids)).filter((d): d is Page => !!d),
    };
  }, [key]);
  return useMemo(() => {
    const rows = (data?.rows ?? []).filter((r) => r.isRow && !r.deletedAt);
    return Object.assign(new Map(rows.map((r) => [r.id, r.title || "未命名"])), {
      rows: new Map(rows.map((r) => [r.id, r])),
      schemas: new Map((data?.dbs ?? []).map((d) => [d.id, d.schema ?? []])),
    });
  }, [data]);
}

// ---------- covers ----------

export const COVERS: Record<string, string> = {
  "grad:moss": "linear-gradient(120deg, #cfe3d4, #8fb8a4)",
  "grad:clay": "linear-gradient(120deg, #f1ddc9, #d9a27c)",
  "grad:dusk": "linear-gradient(120deg, #cdd5ea, #8d9bc9)",
  "grad:plum": "linear-gradient(120deg, #e6d3e4, #b58bb5)",
  "grad:ink": "linear-gradient(120deg, #4a5560, #232a31)",
};

/** CSS for a page cover, or null when the page has none. */
export function useCoverStyle(cover?: string): React.CSSProperties | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (cover?.startsWith("idb://")) void resolveFileUrl(cover).then((u) => alive && setUrl(u));
    else setUrl(null);
    return () => {
      alive = false;
    };
  }, [cover]);
  if (!cover) return null;
  if (cover.startsWith("idb://")) return url ? { backgroundImage: `url(${url})` } : {};
  return { backgroundImage: COVERS[cover] };
}

function RollupFields({ prop, ctx }: { prop: Property; ctx: Ctx }) {
  const relations = ctx.schema.filter((p) => p.type === "relation");
  const rel = relations.find((p) => p.id === prop.rollupRel);
  const target = ctx.titles.schemas?.get(rel?.relationDb ?? "") ?? [];
  if (relations.length === 0) return <div className="hint">先新增一個「關聯」屬性，彙總才有資料可以讀。</div>;
  return (
    <>
      <label className="field">
        關聯
        <select
          value={prop.rollupRel ?? ""}
          onChange={(e) => ctx.patchProp(prop.id, { rollupRel: e.target.value, rollupProp: "title" })}
        >
          <option value="">選擇…</option>
          {relations.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        屬性
        <select
          value={prop.rollupProp ?? "title"}
          disabled={!rel}
          onChange={(e) => ctx.patchProp(prop.id, { rollupProp: e.target.value })}
        >
          <option value="title">名稱</option>
          {target.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        計算
        <select
          value={prop.rollupCalc ?? "show"}
          onChange={(e) => ctx.patchProp(prop.id, { rollupCalc: e.target.value as Property["rollupCalc"] })}
        >
          <option value="show">顯示原始值</option>
          {(Object.keys(CALC_LABEL) as Calc[]).map((k) => (
            <option key={k} value={k}>
              {CALC_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

// ---------- property settings menu ----------

export function PropertyMenu({ prop, ctx, close }: { prop: Property; ctx: Ctx; close: () => void }) {
  const databases =
    useLiveQuery(async () => (await db.pages.toArray()).filter((p) => p.kind === "database" && !p.deletedAt), []) ?? [];
  const hidden = ctx.view.hidden ?? [];
  // live-check the formula against the first row so mistakes show while editing
  const sample = ctx.rows[0];
  const check =
    prop.type === "formula" && prop.formula
      ? evalFormula(prop.formula, (name) => {
          if (name !== "名稱" && name !== "title" && !ctx.schema.some((p) => p.name === name)) {
            throw new Error(`找不到屬性「${name}」`);
          }
          return sample ? 1 : 0;
        })
      : null;

  return (
    <div className="menu">
      <CommitInput
        className="input"
        value={prop.name}
        aria-label="屬性名稱"
        onCommit={(name) => ctx.patchProp(prop.id, { name: name.trim() || prop.name })}
      />
      <label className="field">
        類型
        <select value={prop.type} onChange={(e) => ctx.changeType(prop, e.target.value as PropType)}>
          {(Object.keys(TYPE_LABEL) as PropType[]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
      {prop.type === "relation" && (
        <label className="field">
          連到
          <select
            value={prop.relationDb ?? ""}
            onChange={(e) => ctx.patchProp(prop.id, { relationDb: e.target.value })}
          >
            <option value="">選擇資料庫…</option>
            {databases.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title || "未命名"}
              </option>
            ))}
          </select>
        </label>
      )}
      {prop.type === "rollup" && <RollupFields prop={prop} ctx={ctx} />}
      {prop.type === "formula" && (
        <div className="formula-box">
          <CommitInput
            className="input mono"
            value={prop.formula ?? ""}
            placeholder='prop("單價") * prop("數量")'
            aria-label="公式"
            onCommit={(formula) => ctx.patchProp(prop.id, { formula })}
          />
          {check && !check.ok && <div className="formula-error">{check.error}</div>}
          <div className="hint">
            屬性寫成 prop("名稱")。可用：{FORMULA_FUNCTIONS.filter((f) => f !== "prop").join("、")}
          </div>
        </div>
      )}
      <div className="menu-row">
        <MenuItem icon={<ArrowLeft size={14} />} onClick={() => ctx.moveProp(prop.id, -1)}>
          左移
        </MenuItem>
        <MenuItem icon={<ArrowRight size={14} />} onClick={() => ctx.moveProp(prop.id, 1)}>
          右移
        </MenuItem>
      </div>
      <MenuItem
        icon={<EyeOff size={14} />}
        onClick={() => {
          ctx.patchView({ hidden: [...hidden, prop.id] });
          close();
        }}
      >
        在此檢視中隱藏
      </MenuItem>
      <MenuItem
        danger
        icon={<Trash2 size={14} />}
        onClick={() => {
          ctx.deleteProp(prop.id);
          close();
        }}
      >
        刪除屬性
      </MenuItem>
    </div>
  );
}
