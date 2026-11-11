// Pomodoro timer state. Lives outside React and in localStorage so the
// countdown survives navigation and page reloads.
import { useSyncExternalStore } from "react";
import { db } from "../db";
import { uid } from "./logic";

export interface FocusState {
  minutes: number;
  taskId: string | null;
  /** timestamp when the running timer ends; null when paused / idle */
  endAt: number | null;
  /** ms left when paused; null when idle */
  remaining: number | null;
  startedAt: number | null;
}

const KEY = "focus-state";
const idle = (minutes = 25): FocusState => ({
  minutes,
  taskId: null,
  endAt: null,
  remaining: null,
  startedAt: null,
});

let state: FocusState = (() => {
  try {
    return { ...idle(), ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return idle();
  }
})();

const listeners = new Set<() => void>();

function set(next: FocusState) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export const focus = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  configure(patch: Partial<Pick<FocusState, "minutes" | "taskId">>) {
    set({ ...state, ...patch });
  },
  start() {
    const ms = state.remaining ?? state.minutes * 60_000;
    set({
      ...state,
      endAt: Date.now() + ms,
      remaining: null,
      startedAt: state.startedAt ?? Date.now(),
    });
  },
  pause() {
    if (state.endAt) set({ ...state, remaining: Math.max(0, state.endAt - Date.now()), endAt: null });
  },
  reset() {
    set({ ...idle(state.minutes), taskId: state.taskId });
  },
  /** ms left on the clock right now */
  left(): number {
    if (state.endAt) return Math.max(0, state.endAt - Date.now());
    return state.remaining ?? state.minutes * 60_000;
  },
  /** Called on a ticker; records the session when the countdown hits zero. */
  async tick(): Promise<boolean> {
    if (!state.endAt || Date.now() < state.endAt) return false;
    const done = state;
    set({ ...idle(done.minutes), taskId: done.taskId });
    await db.focus.add({
      id: uid(),
      taskId: done.taskId,
      start: done.startedAt ?? Date.now() - done.minutes * 60_000,
      minutes: done.minutes,
    });
    return true;
  },
};

export function useFocus(): FocusState {
  return useSyncExternalStore(focus.subscribe, focus.get);
}

export function chime() {
  try {
    const ctx = new AudioContext();
    [0, 0.25, 0.5].forEach((t, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = [660, 880, 1100][i];
      g.gain.setValueAtTime(0.15, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.3);
    });
  } catch {
    /* audio unavailable */
  }
}
