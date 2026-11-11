import { useEffect, useRef, useState } from "react";
import { ChevronRight, Copy, GripVertical, Maximize2, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { duplicatePage, placePage, restorePage, trashPage, updatePage } from "../../db";
import { calculate } from "../../lib/logic";
import { toast } from "../../stores";
import type { Calc, Page, PropType, SelectOption } from "../../types";
import { CommitInput, MenuItem, Popover } from "../../ui";
import { PropCell, Tag } from "./PropCell";
import { CALC_LABEL, type Ctx, PropertyMenu, TYPE_LABEL } from "./shared";

export const removeRow = (r: Page) => {
  void trashPage(r.id);
  toast(`已刪除「${r.title || "未命名"}」`, { label: "復原", run: () => void restorePage(r.id) });
};

const DEFAULT_W = 180;
const TITLE_W = 280;

interface Group {
  key: string;
  option?: SelectOption;
  rows: Page[];
}

export function TableView({ ctx }: { ctx: Ctx }) {
  const { visible, rows, view, schema } = ctx;
  const [focusId, setFocusId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; w: number } | null>(null);
  const [overRow, setOverRow] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const canReorder = view.sorts.length === 0;
  const tableRef = useRef<HTMLTableElement>(null);

  // Put the cursor in a newly added row once it has rendered (the row can
  // arrive from the database before or after we learn its id).
  useEffect(() => {
    if (!focusId) return;
    const input = tableRef.current?.querySelector<HTMLInputElement>(
      `tr[data-id="${focusId}"] .cell-input.strong`,
    );
    if (input) {
      input.focus();
      setFocusId(null);
    }
  }, [focusId, rows]);
  const width = (id: string) =>
    drag?.id === id ? drag.w : (view.widths?.[id] ?? (id === "title" ? TITLE_W : DEFAULT_W));

  const groupProp = schema.find((p) => p.id === view.groupBy && p.type === "select");
  const groups: Group[] = groupProp
    ? [
        ...(groupProp.options ?? []).map((o) => ({
          key: o.id,
          option: o,
          rows: rows.filter((r) => r.props?.[groupProp.id] === o.id),
        })),
        {
          key: "",
          option: { id: "", name: "未分類", color: "gray" },
          rows: rows.filter((r) => !(groupProp.options ?? []).some((o) => o.id === r.props?.[groupProp.id])),
        },
      ].filter((g) => g.key !== "" || g.rows.length > 0)
    : [{ key: "all", rows }];

  const startResize = (id: string, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = width(id);
    let w = startW;
    const move = (ev: PointerEvent) => {
      w = Math.max(80, Math.min(640, startW + ev.clientX - startX));
      setDrag({ id, w });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      ctx.patchView({ widths: { ...view.widths, [id]: Math.round(w) } });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const add = async (group?: Group) => {
    if (group) setCollapsed((c) => ({ ...c, [group.key]: false }));
    setFocusId(await ctx.addRow(groupProp && group ? { [groupProp.id]: group.key || null } : {}));
  };

  // Arrow keys move between rows; Enter commits and moves down.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTableElement>) => {
    const el = e.target as HTMLElement;
    if (el.tagName !== "INPUT" || e.nativeEvent.isComposing) return;
    const input = el as HTMLInputElement;
    if (!["ArrowUp", "ArrowDown", "Enter"].includes(e.key)) return;
    if (e.key !== "Enter" && (input.type === "date" || input.type === "number")) return;
    const td = el.closest("td");
    const tr = el.closest("tr");
    if (!td || !tr || !tr.classList.contains("data-row")) return;
    const dataRows = [...e.currentTarget.querySelectorAll<HTMLTableRowElement>("tr.data-row")];
    const i = dataRows.indexOf(tr as HTMLTableRowElement);
    const next = dataRows[i + (e.key === "ArrowUp" ? -1 : 1)];
    e.preventDefault();
    input.blur();
    if (next) {
      const target = next.cells[td.cellIndex]?.querySelector<HTMLElement>("input, button.cell-select");
      target?.focus();
      if (target instanceof HTMLInputElement && target.type === "text") target.select();
    }
  };

  const cols = [{ id: "title", name: "名稱" }, ...visible];
  const total = 32 + cols.reduce((s, c) => s + width(c.id), 0) + 44;

  const renderRow = (r: Page) => (
    <tr
      key={r.id}
      data-id={r.id}
      className={"data-row" + (overRow === r.id ? " drop-before" : "")}
      onDragOver={(e) => {
        if (!canReorder || !e.dataTransfer.types.includes("text/row")) return;
        e.preventDefault();
        setOverRow(r.id);
      }}
      onDragLeave={() => setOverRow((o) => (o === r.id ? null : o))}
      onDrop={(e) => {
        setOverRow(null);
        const id = e.dataTransfer.getData("text/row");
        if (!canReorder || !id || id === r.id) return;
        e.preventDefault();
        void placePage(id, ctx.dbPage.id, r.id);
        // dropping into another group also moves the row to that group
        if (groupProp) ctx.setProp(id, groupProp.id, r.props?.[groupProp.id] ?? null);
      }}
    >
      <td className="col-grip">
        {canReorder && (
          <span
            className="grip"
            draggable
            title="拖曳以調整順序"
            onDragStart={(e) => {
              e.dataTransfer.setData("text/row", r.id);
              e.dataTransfer.effectAllowed = "move";
            }}
          >
            <GripVertical size={14} />
          </span>
        )}
      </td>
      <td className="col-title">
        <div className="title-cell">
          {r.icon && <span>{r.icon}</span>}
          <CommitInput
            className="cell-input strong"
            value={r.title}
            placeholder="未命名"
            aria-label="名稱"
            onCommit={(title) => void updatePage(r.id, { title })}
          />
          <button className="open-btn" onClick={() => ctx.openRow(r.id)}>
            <Maximize2 size={12} /> 開啟
          </button>
        </div>
      </td>
      {visible.map((p) => (
        <td key={p.id}>
          <PropCell
            prop={p}
            row={r}
            schema={schema}
            titles={ctx.titles}
            onChange={(v) => ctx.setProp(r.id, p.id, v)}
            onProp={(patch) => ctx.patchProp(p.id, patch)}
          />
        </td>
      ))}
      <td className="col-add">
        <Popover
          align="end"
          width={160}
          trigger={(tp) => (
            <button className="icon-btn row-del" title="列選單" {...tp}>
              <MoreHorizontal size={14} />
            </button>
          )}
        >
          {(close) => (
            <div className="menu">
              <MenuItem
                icon={<Maximize2 size={14} />}
                onClick={() => {
                  ctx.openRow(r.id);
                  close();
                }}
              >
                開啟
              </MenuItem>
              <MenuItem
                icon={<Copy size={14} />}
                onClick={() => {
                  void duplicatePage(r.id);
                  close();
                }}
              >
                複製
              </MenuItem>
              <MenuItem
                danger
                icon={<Trash2 size={14} />}
                onClick={() => {
                  removeRow(r);
                  close();
                }}
              >
                刪除
              </MenuItem>
            </div>
          )}
        </Popover>
      </td>
    </tr>
  );

  return (
    <div className="table-wrap">
      <table ref={tableRef} className="db-table" style={{ width: total }} onKeyDown={onKeyDown}>
        <colgroup>
          <col style={{ width: 32 }} />
          {cols.map((c) => (
            <col key={c.id} style={{ width: width(c.id) }} />
          ))}
          <col style={{ width: 44 }} />
        </colgroup>
        <thead>
          <tr>
            <th className="col-grip" />
            <th className="col-title">
              <span className="th-label">名稱</span>
              <span className="col-resize" onPointerDown={(e) => startResize("title", e)} />
            </th>
            {visible.map((p) => (
              <th key={p.id}>
                <Popover
                  width={290}
                  trigger={(tp) => (
                    <button className="th-btn" {...tp} title={TYPE_LABEL[p.type]}>
                      {p.name}
                    </button>
                  )}
                >
                  {(close) => <PropertyMenu prop={p} ctx={ctx} close={close} />}
                </Popover>
                <span className="col-resize" onPointerDown={(e) => startResize(p.id, e)} />
              </th>
            ))}
            <th className="col-add">
              <Popover
                align="end"
                width={170}
                trigger={(tp) => (
                  <button className="icon-btn" title="新增屬性" {...tp}>
                    <Plus size={15} />
                  </button>
                )}
              >
                {(close) => (
                  <div className="menu">
                    {(Object.keys(TYPE_LABEL) as PropType[]).map((t) => (
                      <MenuItem
                        key={t}
                        onClick={() => {
                          ctx.addProp(t);
                          close();
                        }}
                      >
                        {TYPE_LABEL[t]}
                      </MenuItem>
                    ))}
                  </div>
                )}
              </Popover>
            </th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.key}>
            {g.option && (
              <tr className="group-row">
                <td colSpan={cols.length + 2}>
                  <button
                    className="icon-btn"
                    aria-expanded={!collapsed[g.key]}
                    aria-label={(collapsed[g.key] ? "展開 " : "收合 ") + g.option.name}
                    onClick={() => setCollapsed((c) => ({ ...c, [g.key]: !c[g.key] }))}
                  >
                    <ChevronRight size={14} className={collapsed[g.key] ? "" : "rot"} />
                  </button>
                  <Tag option={g.option} />
                  <span className="muted small">{g.rows.length}</span>
                  <button className="icon-btn" title={`在「${g.option.name}」新增`} onClick={() => void add(g)}>
                    <Plus size={14} />
                  </button>
                </td>
              </tr>
            )}
            {!collapsed[g.key] && g.rows.map(renderRow)}
          </tbody>
        ))}
        <tfoot>
          <tr>
            <td className="col-grip" />
            {cols.map((c) => {
              const calc = view.calcs?.[c.id];
              return (
                <td key={c.id}>
                  <Popover
                    width={150}
                    trigger={(tp) => (
                      <button className="calc-btn" {...tp}>
                        {calc ? (
                          <>
                            <span className="muted">{CALC_LABEL[calc]}</span>{" "}
                            {calculate(rows, c.id, calc, schema, ctx.titles) || "—"}
                          </>
                        ) : (
                          <span className="calc-empty">計算</span>
                        )}
                      </button>
                    )}
                  >
                    {(close) => (
                      <div className="menu">
                        <MenuItem
                          onClick={() => {
                            const next = { ...view.calcs };
                            delete next[c.id];
                            ctx.patchView({ calcs: next });
                            close();
                          }}
                        >
                          無
                        </MenuItem>
                        {(Object.keys(CALC_LABEL) as Calc[]).map((k) => (
                          <MenuItem
                            key={k}
                            active={calc === k}
                            onClick={() => {
                              ctx.patchView({ calcs: { ...view.calcs, [c.id]: k } });
                              close();
                            }}
                          >
                            {CALC_LABEL[k]}
                          </MenuItem>
                        ))}
                      </div>
                    )}
                  </Popover>
                </td>
              );
            })}
            <td className="col-add" />
          </tr>
        </tfoot>
      </table>
      <button className="add-row" onClick={() => void add()}>
        <Plus size={14} /> 新增一列
      </button>
    </div>
  );
}
