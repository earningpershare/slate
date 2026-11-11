// Small app-wide stores: the row side-peek and toasts.
import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

// ---------- side peek ----------

const peekStore = createStore<string | null>(null);

export const peek = {
  open: (id: string) => peekStore.set(id),
  close: () => peekStore.set(null),
};

export function usePeek(): string | null {
  return useSyncExternalStore(peekStore.subscribe, peekStore.get);
}

// ---------- toasts ----------

interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
}

const toastStore = createStore<Toast[]>([]);
let nextId = 1;

export function toast(message: string, action?: Toast["action"]) {
  const id = nextId++;
  toastStore.set([...toastStore.get().slice(-2), { id, message, action }]);
  setTimeout(() => dismiss(id), action ? 7000 : 3500);
}

const dismiss = (id: number) => toastStore.set(toastStore.get().filter((t) => t.id !== id));

export function Toaster() {
  const toasts = useSyncExternalStore(toastStore.subscribe, toastStore.get);
  // Ctrl+Z right after an undoable action triggers its undo, when not typing.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const last = toastStore.get().findLast((t) => t.action);
      const el = document.activeElement as HTMLElement | null;
      const typing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
      if (last && !typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        last.action!.run();
        dismiss(last.id);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return createPortal(
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.message}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}
