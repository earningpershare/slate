import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

// ---------- hash router ----------

const subscribeHash = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

/** Returns the hash path split in segments, e.g. "#/p/abc" -> ["p", "abc"]. */
export function useRoute(): string[] {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
}

export function navigate(path: string) {
  window.location.hash = path.startsWith("/") ? path : "/" + path;
}

export const openPage = (id: string) => navigate("/p/" + id);

// ---------- persisted state ----------

export function useLocalState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* storage unavailable: keep in memory only */
        }
        return next;
      });
    },
    [key],
  );
  return [value, set] as const;
}

// ---------- popover ----------

interface PopoverProps {
  trigger: (props: { onClick: (e: React.MouseEvent) => void; "aria-expanded": boolean }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end";
  width?: number;
}

export function Popover({ trigger, children, align = "start", width }: PopoverProps) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  return (
    <>
      {trigger({
        "aria-expanded": !!anchor,
        onClick: (e) => {
          e.stopPropagation();
          setAnchor(anchor ? null : (e.currentTarget as HTMLElement).getBoundingClientRect());
        },
      })}
      {anchor && (
        <Floating anchor={anchor} align={align} width={width} onClose={close}>
          {children(close)}
        </Floating>
      )}
    </>
  );
}

export function Floating({
  anchor,
  align = "start",
  width,
  onClose,
  children,
}: {
  anchor: { left: number; right: number; top: number; bottom: number };
  align?: "start" | "end";
  width?: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden", left: 0, top: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = align === "end" ? anchor.right - r.width : anchor.left;
    let top = anchor.bottom + 4;
    left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8));
    if (top + r.height > window.innerHeight - 8) {
      top = Math.max(8, anchor.top - r.height - 4);
    }
    setStyle({ left, top });
  }, [anchor, align]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // defer so the click that opened us doesn't immediately close us
    const t = setTimeout(() => document.addEventListener("mousedown", down));
    document.addEventListener("keydown", key);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="popover"
      style={{ ...style, width }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  danger,
  active,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  active?: boolean;
}) {
  return (
    <button
      className={"menu-item" + (danger ? " danger" : "") + (active ? " active" : "")}
      onClick={onClick}
    >
      {icon && <span className="menu-icon">{icon}</span>}
      <span className="menu-label">{children}</span>
    </button>
  );
}

// ---------- modal ----------

export function Modal({
  onClose,
  children,
  className = "",
  label,
}: {
  onClose: () => void;
  children: ReactNode;
  className?: string;
  label: string;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className={"modal " + className}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ---------- emoji picker ----------

const EMOJI =
  "📄 📝 📒 📓 📔 📕 📗 📘 📙 📚 🗂️ 📁 📋 📌 📎 ✏️ 🖊️ 🔖 💡 ⭐ 🔥 ✅ ❤️ 🎯 🚀 🏠 💼 🧠 🛠️ ⚙️ 🔬 🧪 📊 📈 💰 🗓️ ⏰ 🎨 🎵 🎬 📷 🎮 ⚽ 🍎 ☕ 🍜 🌱 🌳 🌊 ☀️ 🌙 ✈️ 🗺️ 🐱 🐶 🦊 🐼 👋 🙌 💪 🎉 🎁 🔒 🔑 💬 📣 🧭 🧩 🪴"
    .split(" ");

export function EmojiPicker({
  onPick,
  onRemove,
}: {
  onPick: (e: string) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="emoji-picker">
      <input
        className="input"
        placeholder="輸入或貼上任何表情符號（Win + . 開啟系統選單）"
        aria-label="自訂圖示"
        onChange={(e) => {
          const v = [...new Intl.Segmenter().segment(e.target.value.trim())].map((s) => s.segment)[0];
          if (v && /\p{Extended_Pictographic}/u.test(v)) onPick(v);
        }}
      />
      <div className="emoji-grid">
        {EMOJI.map((e) => (
          <button key={e} className="emoji-btn" onClick={() => onPick(e)}>
            {e}
          </button>
        ))}
      </div>
      {onRemove && (
        <button className="btn ghost small" onClick={onRemove}>
          移除圖示
        </button>
      )}
    </div>
  );
}

/** Text input that commits on blur / Enter rather than on every keystroke. */
export function CommitInput({
  value,
  onCommit,
  ...rest
}: {
  value: string;
  onCommit: (v: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
        }
        rest.onKeyDown?.(e);
      }}
    />
  );
}

/**
 * Input / textarea bound to async storage. Keeps its own draft while focused so
 * that IME composition (注音、拼音) is never interrupted by a store round-trip.
 */
export function LiveInput({
  value,
  onSave,
  multiline,
  ...rest
}: {
  value: string;
  onSave: (v: string) => void;
  multiline?: boolean;
  className?: string;
  placeholder?: string;
  "aria-label"?: string;
  autoFocus?: boolean;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const latest = useRef({ draft, onSave, saved: value });
  latest.current.onSave = onSave;

  useEffect(() => {
    latest.current.saved = value;
    if (!focused.current) {
      setDraft(value);
      latest.current.draft = value;
    }
  }, [value]);

  const flush = () => {
    clearTimeout(timer.current);
    const l = latest.current;
    if (l.draft !== l.saved) {
      l.saved = l.draft;
      l.onSave(l.draft);
    }
  };
  useEffect(() => flush, []); // save pending edits on unmount

  const props = {
    ...rest,
    value: draft,
    onFocus: () => (focused.current = true),
    onBlur: () => {
      focused.current = false;
      flush();
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraft(e.target.value);
      latest.current.draft = e.target.value;
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, 500);
    },
  };
  return multiline ? <textarea {...props} /> : <input {...props} />;
}
