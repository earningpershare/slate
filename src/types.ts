export type PropType =
  | "text"
  | "number"
  | "select"
  | "multiSelect"
  | "date"
  | "checkbox"
  | "url"
  | "relation"
  | "formula"
  | "rollup"
  | "createdTime"
  | "updatedTime";

export interface SelectOption {
  id: string;
  name: string;
  color: string;
}

export interface Property {
  id: string;
  name: string;
  type: PropType;
  options?: SelectOption[];
  /** relation: id of the database this property links to */
  relationDb?: string;
  /** formula: expression source */
  formula?: string;
  /** rollup: which relation property to follow, which property to read there, and how to combine */
  rollupRel?: string;
  rollupProp?: string;
  rollupCalc?: "show" | Calc;
}

export type FilterOp =
  | "contains"
  | "notContains"
  | "eq"
  | "neq"
  | "gt"
  | "lt"
  | "empty"
  | "notEmpty"
  | "checked"
  | "unchecked";

export interface Filter {
  id: string;
  propId: string; // "title" for the title column
  op: FilterOp;
  value?: string;
}

export interface Sort {
  propId: string;
  dir: "asc" | "desc";
}

export type ViewType = "table" | "board" | "list" | "calendar" | "gallery" | "timeline";

export type Calc = "count" | "filled" | "sum" | "avg" | "min" | "max";

export interface DbView {
  id: string;
  name: string;
  type: ViewType;
  filters: Filter[];
  sorts: Sort[];
  groupBy?: string;
  dateProp?: string;
  /** timeline: end date property */
  endProp?: string;
  /** property ids hidden in this view */
  hidden?: string[];
  /** table column widths in px, keyed by property id ("title" for the name column) */
  widths?: Record<string, number>;
  /** table footer calculations */
  calcs?: Record<string, Calc>;
}

export type PropValue = string | number | boolean | string[] | null | undefined;

export interface Page extends Synced {
  id: string;
  /** "" = top level (IndexedDB cannot index null) */
  parentId: string;
  kind: "page" | "database";
  /** true when this page is a row of its parent database */
  isRow?: boolean;
  title: string;
  icon?: string;
  cover?: string;
  /** BlockNote document JSON */
  content?: unknown[];
  /** plain text extracted from content, for search */
  text?: string;
  favorite?: boolean;
  fullWidth?: boolean;
  locked?: boolean;
  font?: "default" | "serif" | "mono";
  smallText?: boolean;
  /** ids of pages this page links to (kept in sync on save, for backlinks) */
  links?: string[];
  deletedAt?: number | null;
  createdAt: number;
  updatedAt: number;
  sort: number;
  // database only
  schema?: Property[];
  views?: DbView[];
  // row only
  props?: Record<string, PropValue>;
}

export type Repeat = "daily" | "weekdays" | "weekly" | "monthly" | "yearly";

/**
 * Change tracking for sync, filled in automatically by the database layer
 * (see the hooks in db.ts). Never set these by hand.
 */
export interface Synced {
  /** when this record last changed; the newer rev wins when two devices disagree */
  rev?: number;
  /** 1 = changed on this device and not yet uploaded */
  dirty?: 0 | 1;
}

/** Remembers that a record was deleted, so the deletion can reach other devices. */
export interface Tomb {
  /** "<table>:<id>" */
  key: string;
  table: string;
  id: string;
  rev: number;
  dirty: 0 | 1;
}

export interface Task extends Synced {
  id: string;
  title: string;
  note?: string;
  listId: string | null; // null = inbox
  parentId?: string | null; // subtask
  done: boolean;
  completedAt?: number | null;
  due?: string | null; // YYYY-MM-DD
  dueTime?: string | null; // HH:mm
  priority: 0 | 1 | 2 | 3; // 0 none, 3 high
  repeat?: Repeat | null;
  tags?: string[];
  sort: number;
  createdAt: number;
  deletedAt?: number | null;
}

export interface TaskList extends Synced {
  id: string;
  name: string;
  color: string;
  sort: number;
}

export interface FocusSession extends Synced {
  id: string;
  taskId?: string | null;
  start: number;
  minutes: number;
}

export interface Habit extends Synced {
  id: string;
  name: string;
  icon: string;
  createdAt: number;
  archived?: boolean;
  /** check-in dates, YYYY-MM-DD */
  days: string[];
}

export interface StoredFile extends Synced {
  id: string;
  name: string;
  type: string;
  blob: Blob;
}

export interface Snapshot {
  id: string;
  pageId: string;
  at: number;
  title: string;
  content: unknown[];
}
