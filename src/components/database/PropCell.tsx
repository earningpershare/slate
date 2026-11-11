import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ExternalLink, X } from "lucide-react";
import { OPTION_COLORS, db } from "../../db";
import { cellValue, safeHref, uid, type Titles } from "../../lib/logic";
import { peek } from "../../stores";
import type { Page, Property, PropValue, SelectOption } from "../../types";
import { CommitInput, Popover } from "../../ui";

export function Tag({ option, onRemove }: { option: SelectOption; onRemove?: () => void }) {
  return (
    <span className={"tag tag-" + option.color}>
      {option.name}
      {onRemove && (
        <button
          className="tag-x"
          aria-label={"移除 " + option.name}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}

export function PropCell({
  prop,
  row,
  schema,
  titles,
  onChange,
  onProp,
}: {
  prop: Property;
  row: Page;
  schema: Property[];
  titles?: Titles;
  onChange: (v: PropValue) => void;
  /** update the property definition (used to add select options) */
  onProp: (patch: Partial<Property>) => void;
}) {
  const value = row.props?.[prop.id];
  switch (prop.type) {
    case "formula":
    case "rollup":
    case "createdTime":
    case "updatedTime": {
      const v = cellValue(row, prop.id, schema, titles);
      const text = v === null || v === undefined ? "" : String(v);
      const error = prop.type === "formula" && text.startsWith("#");
      return (
        <span
          className={"cell-static" + (error ? " error" : "") + (typeof v === "number" ? " num" : "")}
          title={error ? text.slice(1) : undefined}
        >
          {error ? "⚠ 公式有誤" : text}
        </span>
      );
    }
    case "relation":
      return <RelationCell prop={prop} value={value} onChange={onChange} />;
    case "checkbox":
      return (
        <label className="cell-check">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            aria-label={prop.name}
          />
        </label>
      );
    case "date":
      return (
        <input
          className={"cell-input" + (value ? "" : " empty")}
          type="date"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || null)}
          aria-label={prop.name}
        />
      );
    case "number":
      return (
        <CommitInput
          className="cell-input num"
          type="number"
          value={value === null || value === undefined ? "" : String(value)}
          onCommit={(v) => onChange(v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v))}
          aria-label={prop.name}
        />
      );
    case "url": {
      const v = typeof value === "string" ? value : "";
      const href = safeHref(v);
      return (
        <span className="cell-url">
          <CommitInput
            className="cell-input"
            value={v}
            onCommit={(nv) => onChange(nv.trim() || null)}
            aria-label={prop.name}
          />
          {href && (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="icon-btn"
              title="開啟連結"
            >
              <ExternalLink size={13} />
            </a>
          )}
        </span>
      );
    }
    case "select":
    case "multiSelect":
      return <SelectCell prop={prop} value={value} onChange={onChange} onProp={onProp} />;
    default:
      return (
        <CommitInput
          className="cell-input"
          value={typeof value === "string" ? value : value == null ? "" : String(value)}
          onCommit={(v) => onChange(v || null)}
          aria-label={prop.name}
        />
      );
  }
}

function RelationCell({
  prop,
  value,
  onChange,
}: {
  prop: Property;
  value: PropValue;
  onChange: (v: PropValue) => void;
}) {
  const target = prop.relationDb ?? "";
  const candidates =
    useLiveQuery(
      async () =>
        target
          ? (await db.pages.where("parentId").equals(target).toArray())
              .filter((r) => r.isRow && !r.deletedAt)
              .sort((a, b) => a.sort - b.sort)
          : [],
      [target],
    ) ?? [];
  const [q, setQ] = useState("");
  const selected: string[] = Array.isArray(value) ? value : [];
  const chosen = selected.map((id) => candidates.find((c) => c.id === id)).filter((c): c is Page => !!c);
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  if (!target) return <span className="cell-static muted">先在屬性設定選擇要連到的資料庫</span>;
  return (
    <Popover
      width={260}
      trigger={(p) => (
        <button className="cell-select" {...p} aria-label={prop.name}>
          {chosen.length === 0 && <span className="muted">&nbsp;</span>}
          {chosen.map((c) => (
            <span
              key={c.id}
              className="rel-chip"
              role="link"
              tabIndex={0}
              title="開啟"
              onClick={(e) => {
                e.stopPropagation();
                peek.open(c.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.stopPropagation();
                  peek.open(c.id);
                }
              }}
            >
              {c.icon ?? "📄"} {c.title || "未命名"}
            </span>
          ))}
        </button>
      )}
    >
      {() => (
        <div className="select-menu">
          <input
            autoFocus
            className="input"
            placeholder="搜尋要連結的項目"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {candidates
            .filter((c) => c.title.toLowerCase().includes(q.trim().toLowerCase()))
            .map((c) => (
              <button
                key={c.id}
                className={"menu-item" + (selected.includes(c.id) ? " active" : "")}
                onClick={() => toggle(c.id)}
              >
                <span className="menu-label">
                  {c.icon ?? "📄"} {c.title || "未命名"}
                </span>
              </button>
            ))}
          {candidates.length === 0 && <div className="hint">目標資料庫還沒有任何項目</div>}
        </div>
      )}
    </Popover>
  );
}

function SelectCell({
  prop,
  value,
  onChange,
  onProp,
}: {
  prop: Property;
  value: PropValue;
  onChange: (v: PropValue) => void;
  onProp: (patch: Partial<Property>) => void;
}) {
  const multi = prop.type === "multiSelect";
  const options = prop.options ?? [];
  const selected: string[] = Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [];
  const chosen = selected
    .map((id) => options.find((o) => o.id === id))
    .filter((o): o is SelectOption => !!o);

  const pick = (id: string, close: () => void) => {
    if (multi) {
      onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
    } else {
      onChange(selected[0] === id ? null : id);
      close();
    }
  };

  return (
    <Popover
      width={250}
      trigger={(p) => (
        <button className="cell-select" {...p} aria-label={prop.name}>
          {chosen.length === 0 && <span className="muted">&nbsp;</span>}
          {chosen.map((o) => (
            <Tag key={o.id} option={o} />
          ))}
        </button>
      )}
    >
      {(close) => (
        <SelectMenu
          options={options}
          selected={selected}
          onPick={(id) => pick(id, close)}
          onCreate={(name) => {
            const opt: SelectOption = {
              id: uid(),
              name,
              color: OPTION_COLORS[options.length % OPTION_COLORS.length],
            };
            onProp({ options: [...options, opt] });
            onChange(multi ? [...selected, opt.id] : opt.id);
            if (!multi) close();
          }}
          onDelete={(id) => {
            onProp({ options: options.filter((o) => o.id !== id) });
            if (selected.includes(id)) {
              onChange(multi ? selected.filter((s) => s !== id) : null);
            }
          }}
          onColor={(id) =>
            onProp({
              options: options.map((o) =>
                o.id === id
                  ? { ...o, color: OPTION_COLORS[(OPTION_COLORS.indexOf(o.color) + 1) % OPTION_COLORS.length] }
                  : o,
              ),
            })
          }
        />
      )}
    </Popover>
  );
}

function SelectMenu({
  options,
  selected,
  onPick,
  onCreate,
  onDelete,
  onColor,
}: {
  options: SelectOption[];
  selected: string[];
  onPick: (id: string) => void;
  onCreate: (name: string) => void;
  onDelete: (id: string) => void;
  onColor: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const name = q.trim();
  const shown = options.filter((o) => o.name.toLowerCase().includes(name.toLowerCase()));
  const exact = options.some((o) => o.name === name);
  return (
    <div className="select-menu">
      <input
        autoFocus
        className="input"
        placeholder="搜尋或建立選項"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || !name || e.nativeEvent.isComposing) return;
          const hit = options.find((o) => o.name === name);
          if (hit) onPick(hit.id);
          else onCreate(name);
          setQ("");
        }}
      />
      {shown.map((o) => (
        <div key={o.id} className={"select-row" + (selected.includes(o.id) ? " active" : "")}>
          <button className="select-pick" onClick={() => onPick(o.id)}>
            <Tag option={o} />
          </button>
          <button
            className={"color-dot tag-" + o.color}
            title="換顏色"
            aria-label={`更換「${o.name}」的顏色`}
            onClick={() => onColor(o.id)}
          />
          <button className="icon-btn" title="刪除選項" onClick={() => onDelete(o.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
      {name && !exact && (
        <button
          className="menu-item"
          onClick={() => {
            onCreate(name);
            setQ("");
          }}
        >
          建立「{name}」
        </button>
      )}
      {!name && options.length === 0 && <div className="hint">輸入文字後按 Enter 建立選項</div>}
    </div>
  );
}
