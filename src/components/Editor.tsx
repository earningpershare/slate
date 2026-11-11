import { useEffect, useRef } from "react";
import {
  BlockNoteEditor,
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  filterSuggestionItems,
  insertOrUpdateBlockForSlashMenu,
} from "@blocknote/core";
import { zhTW } from "@blocknote/core/locales";
import {
  SuggestionMenuController,
  createReactBlockSpec,
  createReactInlineContentSpec,
  getDefaultReactSlashMenuItems,
  useCreateBlockNote,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { useLiveQuery } from "dexie-react-hooks";
import { FileText, Lightbulb, Link2, Maximize2, Plus, Table2 } from "lucide-react";
import { createDatabase, createPage, db, resolveFileUrl, saveFile, updatePage } from "../db";
import { LiveInput, openPage } from "../ui";
import DatabaseView from "./database/DatabaseView";
import { columnDictionary, columnDropCursor, columnSlashItems, withColumns } from "./multiColumn";

const iconOf = (p?: { icon?: string; kind?: string } | null) =>
  p?.icon ?? (p?.kind === "database" ? "🗃️" : "📄");

// A link to another page, shown as a row inside the document (sub-pages).
const PageLink = createReactBlockSpec(
  { type: "pageLink", propSchema: { pageId: { default: "" } }, content: "none" },
  {
    render: ({ block }) => {
      const id = block.props.pageId;
      const page = useLiveQuery(() => db.pages.get(id), [id]);
      const gone = page === undefined || !!page?.deletedAt;
      return (
        <button
          className={"page-link" + (gone ? " gone" : "")}
          contentEditable={false}
          onClick={() => !gone && openPage(id)}
        >
          <span className="page-link-icon">{iconOf(page)}</span>
          <span className="page-link-title">{gone ? "頁面已刪除" : page?.title || "未命名"}</span>
        </button>
      );
    },
  },
);

// A database shown in place, inside the document.
const InlineDatabase = createReactBlockSpec(
  { type: "database", propSchema: { pageId: { default: "" } }, content: "none" },
  {
    render: ({ block }) => {
      const id = block.props.pageId;
      const page = useLiveQuery(async () => (await db.pages.get(id)) ?? null, [id]);
      if (page === undefined) return <div className="inline-db" contentEditable={false} />;
      if (page === null || page.deletedAt || page.kind !== "database") {
        return (
          <div className="page-link gone" contentEditable={false}>
            <span className="page-link-icon">🗃️</span>
            <span className="page-link-title">資料庫已刪除</span>
          </div>
        );
      }
      return (
        <div className="inline-db" contentEditable={false}>
          <div className="inline-db-head">
            <span>{iconOf(page)}</span>
            <LiveInput
              className="inline-db-title"
              value={page.title}
              placeholder="未命名資料庫"
              aria-label="資料庫名稱"
              onSave={(title) => void updatePage(page.id, { title })}
            />
            <button className="open-btn shown" onClick={() => openPage(page.id)}>
              <Maximize2 size={12} /> 整頁開啟
            </button>
          </div>
          <DatabaseView dbPage={page} inline />
        </div>
      );
    },
  },
);

const CALLOUT_EMOJI = ["💡", "⚠️", "❗", "✅", "📌", "💬"];

const Callout = createReactBlockSpec(
  { type: "callout", propSchema: { emoji: { default: "💡" } }, content: "inline" },
  {
    render: ({ block, editor, contentRef }) => (
      <div className="callout">
        <button
          className="callout-emoji"
          contentEditable={false}
          title="切換圖示"
          onClick={() => {
            if (!editor.isEditable) return;
            const i = CALLOUT_EMOJI.indexOf(block.props.emoji);
            editor.updateBlock(block, {
              props: { emoji: CALLOUT_EMOJI[(i + 1) % CALLOUT_EMOJI.length] },
            });
          }}
        >
          {block.props.emoji}
        </button>
        <div className="callout-body" ref={contentRef} />
      </div>
    ),
  },
);

// An inline @mention of another page.
const Mention = createReactInlineContentSpec(
  { type: "mention", propSchema: { pageId: { default: "" } }, content: "none" },
  {
    render: ({ inlineContent }) => {
      const id = inlineContent.props.pageId;
      const page = useLiveQuery(() => db.pages.get(id), [id]);
      const gone = !page || !!page.deletedAt;
      return (
        <span
          className={"mention" + (gone ? " gone" : "")}
          role="link"
          tabIndex={0}
          onClick={() => !gone && openPage(id)}
          onKeyDown={(e) => e.key === "Enter" && !gone && openPage(id)}
        >
          {iconOf(page)} {gone ? "已刪除的頁面" : page.title || "未命名"}
        </span>
      );
    },
  },
);

export const schema = withColumns(
  BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      pageLink: PageLink(),
      database: InlineDatabase(),
      callout: Callout(),
    },
    inlineContentSpecs: { ...defaultInlineContentSpecs, mention: Mention },
  }),
);

export type AppEditor = typeof schema.BlockNoteEditor;

/** Parse Markdown into document blocks (used by import; needs no mounted editor). */
export function markdownToBlocks(md: string): unknown[] {
  return BlockNoteEditor.create({ schema }).tryParseMarkdownToBlocks(md);
}

export default function Editor({
  pageId,
  initialContent,
  dark,
  editable = true,
  onReady,
}: {
  pageId: string;
  initialContent?: unknown[];
  dark: boolean;
  editable?: boolean;
  onReady?: (editor: AppEditor) => void;
}) {
  const editor = useCreateBlockNote({
    schema,
    dictionary: { ...zhTW, multi_column: columnDictionary },
    dropCursor: columnDropCursor,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initialContent: initialContent?.length ? (initialContent as any) : undefined,
    uploadFile: saveFile,
    resolveFileUrl,
  });

  // Debounced save; the pending save is flushed when leaving the page.
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const dirty = useRef(false);
  useEffect(() => {
    onReady?.(editor);
    const save = () => {
      if (!dirty.current) return;
      dirty.current = false;
      void updatePage(pageId, { content: editor.document });
    };
    const off = editor.onChange(() => {
      dirty.current = true;
      clearTimeout(timer.current);
      timer.current = setTimeout(save, 400);
    });
    window.addEventListener("beforeunload", save);
    return () => {
      off?.();
      clearTimeout(timer.current);
      window.removeEventListener("beforeunload", save);
      save();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, pageId]);

  const saveNow = async () => {
    dirty.current = false;
    clearTimeout(timer.current);
    await updatePage(pageId, { content: editor.document });
  };

  const addChild = async (kind: "page" | "database" | "inlineDb") => {
    const id = kind === "page" ? await createPage(pageId) : await createDatabase(pageId);
    insertOrUpdateBlockForSlashMenu(editor, {
      type: kind === "inlineDb" ? "database" : "pageLink",
      props: { pageId: id },
    });
    await saveNow();
    if (kind !== "inlineDb") openPage(id);
  };

  const slashItems = (query: string) =>
    filterSuggestionItems(
      [
        {
          title: "頁面",
          subtext: "在這一頁底下建立子頁面",
          aliases: ["page", "ye", "yemian", "子頁面"],
          group: "工作區",
          icon: <FileText size={18} />,
          onItemClick: () => void addChild("page"),
        },
        {
          title: "資料庫（內嵌）",
          subtext: "直接在這一頁裡顯示表格、看板、月曆等檢視",
          aliases: ["database", "table", "db", "ziliaoku", "inline", "看板", "表格"],
          group: "工作區",
          icon: <Table2 size={18} />,
          onItemClick: () => void addChild("inlineDb"),
        },
        {
          title: "資料庫（整頁）",
          subtext: "建立獨立的資料庫頁面並前往",
          aliases: ["database", "full", "db", "ziliaoku"],
          group: "工作區",
          icon: <Maximize2 size={18} />,
          onItemClick: () => void addChild("database"),
        },
        {
          title: "標註",
          subtext: "用底色框強調一段文字",
          aliases: ["callout", "biaozhu", "提示"],
          group: "工作區",
          icon: <Lightbulb size={18} />,
          onItemClick: () => void insertOrUpdateBlockForSlashMenu(editor, { type: "callout" }),
        },
        {
          title: "提及頁面",
          subtext: "也可以直接輸入 @ 加頁面名稱",
          aliases: ["mention", "link", "tiji", "@"],
          group: "工作區",
          icon: <Link2 size={18} />,
          onItemClick: () => editor.insertInlineContent("@"),
        },
        ...columnSlashItems(editor),
        ...getDefaultReactSlashMenuItems(editor),
      ],
      query,
    );

  const mentionItems = async (query: string) => {
    const q = query.trim().toLowerCase();
    const pages = (await db.pages.toArray())
      .filter((p) => !p.deletedAt && p.id !== pageId && p.title.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8);
    const insert = (id: string) =>
      editor.insertInlineContent([{ type: "mention", props: { pageId: id } }, " "]);
    return [
      ...pages.map((p) => ({
        title: `${iconOf(p)} ${p.title || "未命名"}`,
        group: "連結到頁面",
        onItemClick: () => insert(p.id),
      })),
      ...(query.trim()
        ? [
            {
              title: `建立「${query.trim()}」`,
              subtext: "新增為這一頁的子頁面並連結過去",
              group: "新頁面",
              icon: <Plus size={18} />,
              onItemClick: async () => insert(await createPage(pageId, { title: query.trim() })),
            },
          ]
        : []),
    ];
  };

  return (
    <BlockNoteView editor={editor} theme={dark ? "dark" : "light"} slashMenu={false} editable={editable}>
      <SuggestionMenuController triggerCharacter="/" getItems={async (q) => slashItems(q)} />
      <SuggestionMenuController triggerCharacter="@" getItems={mentionItems} />
    </BlockNoteView>
  );
}
