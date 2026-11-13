import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { CheckSquare, Download, House, Menu, PanelLeftOpen, Plus, Search, Upload } from "lucide-react";
import { createPage, db, exportAll, importAll, seedIfEmpty } from "./db";
import { Toaster, peek, toast, usePeek } from "./stores";
import {
  backupState,
  backupSupported,
  chooseBackupDir,
  clearBackupDir,
  getBackupDir,
  lastBackupAt,
  reallowBackup,
  runBackup,
} from "./lib/autobackup";
import { rememberSeed } from "./lib/link";
import { SyncSection } from "./components/DeviceSync";
import { InstallBar, InstallSection, Landing, wantsLanding } from "./components/Install";
import { Modal, NARROW, navigate, openPage, useLocalState, useMedia, useRoute } from "./ui";
import Home from "./components/Home";
import PageView from "./components/PageView";
import Sidebar, { pageIcon } from "./components/Sidebar";
import TasksView, { FocusTicker, ReminderTicker } from "./components/tasks/TasksView";

type Theme = "system" | "light" | "dark";

function useDark(theme: Theme): boolean {
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const dark = theme === "dark" || (theme === "system" && systemDark);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    // the phone's status bar / browser toolbar takes the page background colour
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#1b1c1a" : "#fbfaf7");
  }, [dark]);
  return dark;
}

let starting: Promise<void> | null = null;

export default function App() {
  const route = useRoute();
  const [theme, setTheme] = useLocalState<Theme>("theme", "system");
  // Wide screens remember whether the sidebar is pinned open. On a phone it is a
  // drawer instead: closed by default, and closed again after every navigation.
  const narrow = useMedia(NARROW);
  const [pinned, setPinned] = useLocalState("sidebar", true);
  const [drawer, setDrawer] = useState(false);
  const sidebar = narrow ? drawer : pinned;
  const setSidebar = narrow ? setDrawer : setPinned;
  const [sideW, setSideW] = useLocalState("sidebar-width", 252);
  const [dragW, setDragW] = useState<number | null>(null);
  const peekId = usePeek();
  const [search, setSearch] = useState(false);
  const [settings, setSettings] = useState(false);
  const [ready, setReady] = useState(false);
  const dark = useDark(theme);
  // phone visitors who have not installed Slate see the download page first
  const [landing, setLanding] = useState(wantsLanding);

  useEffect(() => {
    starting ??= (async () => {
      // remembered so that linking a still-untouched device does not leave the sample pages twice
      if (await seedIfEmpty()) await rememberSeed(db);
    })();
    void starting.then(() => setReady(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Automatic folder backup: every few minutes, and when the tab is hidden.
  useEffect(() => {
    void backupState().then((s) => {
      if (s === "prompt") {
        toast("自動備份需要重新允許存取資料夾", {
          label: "允許",
          run: () => void reallowBackup().then((ok) => toast(ok ? "自動備份已恢復" : "沒有取得資料夾權限")),
        });
      }
    });
    const tick = () => void runBackup().catch(() => undefined);
    const t = setInterval(tick, 5 * 60_000);
    const hidden = () => document.visibilityState === "hidden" && tick();
    document.addEventListener("visibilitychange", hidden);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch(true);
      } else if (e.key === "\\") {
        e.preventDefault();
        setSidebar((s) => !s);
      }
    };
    // Alt+N: new page (Ctrl+N belongs to the browser)
    const alt = async (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        openPage(await createPage(null));
      }
      if (e.key === "Escape" && !document.querySelector(".popover, .modal-backdrop")) peek.close();
    };
    window.addEventListener("keydown", alt);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("keydown", alt);
    };
  }, [setSidebar]);

  // navigating anywhere closes the side peek
  const hash = route.join("/");
  useEffect(() => {
    peek.close();
    setDrawer(false);
  }, [hash]);

  // Phones: follow the visible viewport so the layout shrinks above the on-screen
  // keyboard instead of being covered by it.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !narrow) return;
    const root = document.documentElement;
    const fit = () => {
      root.style.setProperty("--app-h", Math.round(vv.height) + "px");
      root.classList.toggle("kbd-open", window.innerHeight - vv.height > 140);
      if (vv.offsetTop > 0) window.scrollTo(0, 0);
    };
    fit();
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    return () => {
      vv.removeEventListener("resize", fit);
      vv.removeEventListener("scroll", fit);
      root.style.removeProperty("--app-h");
      root.classList.remove("kbd-open");
    };
  }, [narrow]);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    let w = sideW;
    const move = (ev: PointerEvent) => {
      w = Math.max(200, Math.min(480, ev.clientX));
      setDragW(w);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragW(null);
      setSideW(w);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // "/" -> last opened page, else the first top-level page
  useEffect(() => {
    if (!ready || route.length > 0) return;
    void (async () => {
      const last = localStorage.getItem("last-page");
      const lastPage = last ? await db.pages.get(last) : undefined;
      if (lastPage && !lastPage.deletedAt) return openPage(lastPage.id);
      const roots = (await db.pages.where("parentId").equals("").toArray())
        .filter((p) => !p.deletedAt)
        .sort((a, b) => a.sort - b.sort);
      if (roots[0]) openPage(roots[0].id);
      else navigate("/home");
    })();
  }, [ready, route.length]);

  if (landing) return <Landing onContinue={() => setLanding(false)} />;
  if (!ready) return null;

  const [section, arg] = route;
  return (
    <div
      className={"app" + (sidebar ? "" : " no-sidebar") + (dragW ? " resizing" : "") + (narrow ? " narrow" : "")}
      style={sidebar && !narrow ? { gridTemplateColumns: `${dragW ?? sideW}px minmax(0, 1fr)` } : undefined}
    >
      <FocusTicker />
      <ReminderTicker />
      <Toaster />
      <InstallBar />
      {sidebar && !narrow && (
        <div className="side-resize" style={{ left: (dragW ?? sideW) - 3 }} onPointerDown={startResize} />
      )}
      {sidebar && narrow && <div className="scrim" onClick={() => setDrawer(false)} />}
      {sidebar && (
        <div
          className="side-wrap"
          onClick={(e) => {
            // tapping the page you are already on changes no route, so close the drawer here
            if (narrow && (e.target as HTMLElement).closest(".tree-main, .nav-row:not([aria-expanded])")) setDrawer(false);
          }}
        >
          <Sidebar
            currentId={section === "p" ? arg : undefined}
            section={section}
            onSearch={() => {
              setDrawer(false);
              setSearch(true);
            }}
            onSettings={() => {
              setDrawer(false);
              setSettings(true);
            }}
            onCollapse={() => setSidebar(false)}
          />
        </div>
      )}
      <main className="main">
        {section === "p" && arg ? (
          <PageView
            key={arg}
            id={arg}
            dark={dark}
            sidebarHidden={!sidebar}
            onShowSidebar={() => setSidebar(true)}
          />
        ) : section === "home" ? (
          <Home sidebarHidden={!sidebar} onShowSidebar={() => setSidebar(true)} />
        ) : section === "tasks" ? (
          <div className="page-shell">
            {!sidebar && (
              <header className="topbar">
                <button className="icon-btn" title="顯示側邊欄（Ctrl + \）" onClick={() => setSidebar(true)}>
                  <PanelLeftOpen size={16} />
                </button>
              </header>
            )}
            <TasksView view={arg ?? "today"} />
          </div>
        ) : null}
      </main>
      {narrow && (
        <nav className="tabbar" aria-label="主要導覽">
          <button className={section === "home" ? "active" : ""} onClick={() => navigate("/home")}>
            <House size={21} />
            <span>首頁</span>
          </button>
          <button onClick={() => setSearch(true)}>
            <Search size={21} />
            <span>搜尋</span>
          </button>
          <button className="tab-new" aria-label="新頁面" onClick={async () => openPage(await createPage(null))}>
            <Plus size={22} />
          </button>
          <button className={section === "tasks" ? "active" : ""} onClick={() => navigate("/tasks/today")}>
            <CheckSquare size={21} />
            <span>待辦</span>
          </button>
          <button className={drawer ? "active" : ""} onClick={() => setDrawer((d) => !d)}>
            <Menu size={21} />
            <span>頁面</span>
          </button>
        </nav>
      )}
      {peekId && (
        <aside className="peek" aria-label="頁面預覽">
          <PageView key={peekId} id={peekId} dark={dark} mode="peek" />
        </aside>
      )}
      {search && <SearchModal onClose={() => setSearch(false)} />}
      {settings && (
        <SettingsModal theme={theme} onTheme={setTheme} onClose={() => setSettings(false)} />
      )}
    </div>
  );
}

// ---------- search ----------

function SearchModal({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const pages = useLiveQuery(() => db.pages.toArray(), []) ?? [];
  const tasks = useLiveQuery(() => db.tasks.toArray(), []) ?? [];
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const byId = new Map(pages.map((p) => [p.id, p]));
    const alive = pages.filter((p) => {
      for (let cur: typeof p | undefined = p; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
        if (cur.deletedAt) return false;
      }
      return true;
    });
    const term = q.trim().toLowerCase();
    if (!term) {
      return alive
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 8)
        .map((p) => ({ key: p.id, icon: pageIcon(p), title: p.title || "未命名", sub: "最近編輯", go: () => openPage(p.id) }));
    }
    const snippet = (text: string) => {
      const i = text.toLowerCase().indexOf(term);
      return i < 0 ? "" : (i > 20 ? "…" : "") + text.slice(Math.max(0, i - 20), i + 60);
    };
    const inTitle = alive.filter((p) => p.title.toLowerCase().includes(term));
    const inBody = alive.filter(
      (p) => !p.title.toLowerCase().includes(term) && (p.text ?? "").toLowerCase().includes(term),
    );
    return [
      ...[...inTitle, ...inBody].slice(0, 30).map((p) => ({
        key: p.id,
        icon: pageIcon(p),
        title: p.title || "未命名",
        sub: snippet(p.text ?? "") || (byId.get(p.parentId)?.title ?? ""),
        go: () => openPage(p.id),
      })),
      ...tasks
        .filter((t) => (t.title + " " + (t.note ?? "")).toLowerCase().includes(term))
        .slice(0, 10)
        .map((t) => ({
          key: t.id,
          icon: <CheckSquare size={15} />,
          title: t.title,
          sub: t.done ? "已完成的任務" : "任務",
          go: () => navigate("/tasks/" + (t.done ? "done" : "all")),
        })),
    ];
  }, [q, pages, tasks]);

  useEffect(() => setIndex(0), [q]);
  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const pick = (i: number) => {
    const r = results[i];
    if (!r) return;
    r.go();
    onClose();
  };

  return (
    <Modal onClose={onClose} className="search" label="搜尋">
      <input
        autoFocus
        className="search-input"
        placeholder="搜尋頁面、內文與任務…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIndex((i) => Math.min(i + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIndex((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") pick(index);
        }}
      />
      <div className="search-results" ref={listRef}>
        {results.map((r, i) => (
          <button
            key={r.key}
            className={"search-row" + (i === index ? " active" : "")}
            onMouseEnter={() => setIndex(i)}
            onClick={() => pick(i)}
          >
            <span className="nav-icon">{r.icon}</span>
            <span className="search-title">{r.title}</span>
            <span className="search-sub">{r.sub}</span>
          </button>
        ))}
        {results.length === 0 && <div className="hint">找不到符合「{q}」的內容</div>}
      </div>
    </Modal>
  );
}

// ---------- settings ----------

function SettingsModal({
  theme,
  onTheme,
  onClose,
}: {
  theme: Theme;
  onTheme: (t: Theme) => void;
  onClose: () => void;
}) {
  const [msg, setMsg] = useState("");
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [usage, setUsage] = useState("");
  const [auto, setAuto] = useState<{ dir: string | null; state: string; last: number }>({
    dir: null,
    state: "none",
    last: 0,
  });
  const refreshAuto = async () =>
    setAuto({
      // a drive root has an empty name, so fall back to a generic label
      dir: await getBackupDir().then((d) => (d ? d.name || "所選資料夾" : null)),
      state: await backupState(),
      last: lastBackupAt(),
    });
  useEffect(() => void refreshAuto(), []);

  useEffect(() => {
    void navigator.storage?.persisted?.().then(setPersisted);
    void navigator.storage?.estimate?.().then((e) => {
      if (e.usage !== undefined) setUsage((e.usage / 1024 / 1024).toFixed(1) + " MB");
    });
  }, []);

  const doExport = async () => {
    const url = URL.createObjectURL(new Blob([await exportAll()], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `slate-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMsg("已匯出備份檔。");
  };

  const doImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      if (!confirm("匯入會取代目前所有的頁面與任務。確定要繼續嗎？")) return;
      try {
        await importAll(await f.text());
        setMsg("匯入完成。");
        navigate("/");
      } catch (e) {
        setMsg("匯入失敗：" + (e instanceof Error ? e.message : "檔案無法讀取") + "。目前的資料沒有被更動。");
      }
    };
    input.click();
  };

  // from another app: added to what is here, nothing is replaced
  const [importing, setImporting] = useState(false);
  const doImportOther = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,.csv,application/zip,text/csv";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      setImporting(true);
      setMsg("匯入中，檔案大的話需要一點時間…");
      try {
        const [{ importFile }, { markdownToBlocks }] = await Promise.all([import("./lib/importers"), import("./components/Editor")]);
        const r = await importFile(f, markdownToBlocks);
        if (r.kind === "ticktick") {
          setMsg(`已從滴答清單匯入 ${r.tasks} 筆任務${r.lists ? `、${r.lists} 個清單` : ""}。`);
          navigate("/tasks/inbox");
        } else {
          setMsg(
            `已從 Notion 匯入 ${r.pages} 個頁面${r.databases ? `、${r.databases} 個資料庫（${r.rows} 列）` : ""}${r.files ? `、${r.files} 個附件` : ""}，放在「從 Notion 匯入」底下。`,
          );
          openPage(r.root);
        }
      } catch (e) {
        setMsg("匯入失敗：" + (e instanceof Error ? e.message : "檔案無法讀取"));
      }
      setImporting(false);
    };
    input.click();
  };

  return (
    <Modal onClose={onClose} className="settings" label="設定與備份">
      <h2>設定與備份</h2>

      <h3>外觀</h3>
      <span className="seg">
        {(["system", "light", "dark"] as Theme[]).map((t) => (
          <button key={t} className={"seg-btn" + (theme === t ? " active" : "")} onClick={() => onTheme(t)}>
            {{ system: "跟隨系統", light: "淺色", dark: "深色" }[t]}
          </button>
        ))}
      </span>

      <h3>手動備份</h3>
      <p className="muted">
        所有資料只存在這台裝置的這個瀏覽器裡{usage && `（目前約 ${usage}）`}。清除瀏覽器資料會一併清掉，請定期匯出備份。
      </p>
      <div className="row">
        <button className="btn primary" onClick={() => void doExport()}>
          <Download size={15} /> 匯出備份
        </button>
        <button className="btn" onClick={doImport}>
          <Upload size={15} /> 從備份還原
        </button>
      </div>
      <p className="muted" style={{ marginTop: 14 }}>
        從別的 App 搬過來：Notion 匯出的 .zip（匯出時選「Markdown & CSV」並包含子頁面），或滴答清單／TickTick 的備份 .csv。
        匯入的內容會加進來，不會取代現有資料。
      </p>
      <div className="row">
        <button className="btn" disabled={importing} onClick={doImportOther}>
          <Upload size={15} /> {importing ? "匯入中…" : "從 Notion／滴答清單匯入"}
        </button>
      </div>
      {msg && (
        <p role="status" className="status">
          {msg}
        </p>
      )}

      <h3>自動備份到資料夾</h3>
      {!backupSupported() ? (
        <p className="muted">這個瀏覽器不支援寫入資料夾（手機瀏覽器都不支援；電腦請用 Edge 或 Chrome），請定期手動匯出。</p>
      ) : auto.dir ? (
        <>
          <p className="muted">
            每 5 分鐘把有變動的資料寫入「{auto.dir}」，每天一個檔案，保留最近 14 天。
            {auto.last > 0 && ` 上次備份：${new Date(auto.last).toLocaleString("zh-TW")}`}
          </p>
          <div className="row">
            {auto.state !== "granted" && (
              <button
                className="btn primary"
                onClick={async () => {
                  setMsg((await reallowBackup()) ? "自動備份已恢復。" : "沒有取得資料夾權限。");
                  void refreshAuto();
                }}
              >
                重新允許存取
              </button>
            )}
            <button
              className="btn"
              onClick={async () => {
                setMsg((await runBackup(true)) ? "已立即備份。" : "備份失敗：沒有資料夾權限。");
                void refreshAuto();
              }}
            >
              立即備份
            </button>
            <button
              className="btn"
              onClick={async () => {
                await clearBackupDir();
                void refreshAuto();
              }}
            >
              停用
            </button>
          </div>
        </>
      ) : (
        <div className="row">
          <p className="muted" style={{ flex: 1, margin: 0 }}>
            選一個資料夾（例如雲端硬碟的同步資料夾），之後會自動把備份寫進去。
          </p>
          <button
            className="btn primary"
            onClick={async () => {
              try {
                setMsg(`已開始自動備份到「${(await chooseBackupDir()) || "所選資料夾"}」。`);
              } catch (e) {
                if ((e as Error).name !== "AbortError") setMsg("無法使用這個資料夾：" + (e as Error).message);
              }
              void refreshAuto();
            }}
          >
            選擇資料夾
          </button>
        </div>
      )}

      <h3>安裝到這台裝置</h3>
      <InstallSection />

      <h3>跨裝置同步</h3>
      <SyncSection onMessage={setMsg} />

      <h3>儲存保護</h3>
      {persisted ? (
        <p className="muted">已啟用：瀏覽器不會在磁碟空間不足時自動清除這裡的資料。</p>
      ) : (
        <div className="row">
          <p className="muted" style={{ flex: 1, margin: 0 }}>
            尚未啟用。啟用後，瀏覽器不會在空間不足時自動清除資料。
          </p>
          <button
            className="btn"
            onClick={async () => {
              const ok = (await navigator.storage?.persist?.()) ?? false;
              setPersisted(ok);
              if (!ok) setMsg("瀏覽器沒有同意。把這個網站安裝成應用程式或加入書籤後再試一次。");
            }}
          >
            啟用
          </button>
        </div>
      )}

      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          完成
        </button>
      </div>
    </Modal>
  );
}
