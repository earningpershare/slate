// Multi-column layout. This is the ONLY file that imports @blocknote/xl-multi-column,
// which is licensed "GPL-3.0 OR PROPRIETARY" (the rest of the app's dependencies are
// permissive). Fine for personal use; before distributing the app to others or using it
// commercially, either buy a BlockNote licence or remove it:
//   1. npm uninstall @blocknote/xl-multi-column
//   2. replace the exports below with the pass-through versions in the comment at the bottom
// Pages that already contain columns would then need those blocks removed first.
import {
  getMultiColumnSlashMenuItems,
  multiColumnDropCursor,
  withMultiColumn,
} from "@blocknote/xl-multi-column";

export const withColumns = withMultiColumn;
export const columnDropCursor = multiColumnDropCursor;
export const columnSlashItems = getMultiColumnSlashMenuItems;

export const columnDictionary = {
  slash_menu: {
    two_columns: {
      title: "兩欄",
      subtext: "把內容並排成左右兩欄",
      aliases: ["columns", "column", "col", "liang", "兩欄", "分欄", "並排"],
      group: "排版",
    },
    three_columns: {
      title: "三欄",
      subtext: "把內容並排成三欄",
      aliases: ["columns", "column", "col", "san", "三欄", "分欄"],
      group: "排版",
    },
  },
};

// Pass-through versions (no multi-column):
//   export const withColumns = <T>(schema: T) => schema;
//   export const columnDropCursor = undefined;
//   export const columnSlashItems = () => [];
//   export const columnDictionary = {};
