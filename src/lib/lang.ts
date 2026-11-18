// Which Chinese the interface is shown in. The app is written in Traditional; the build gives
// every piece of text its Simplified form too (scripts/simplified.mjs) and the two small
// functions at the bottom pick between them. Only the interface changes: what the person
// wrote is never converted.

export type Lang = "zh-TW" | "zh-CN";

const KEY = "slate:lang";

/** What the person chose, or null when they have not: then the device's own language decides. */
export function chosenLang(): Lang | null {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === "zh-TW" || saved === "zh-CN" ? saved : null;
  } catch {
    return null; // no storage (a private window, or not a browser at all)
  }
}

function deviceLang(): Lang {
  const wanted = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language ?? ""];
  for (const raw of wanted) {
    const tag = raw.toLowerCase();
    if (!tag.startsWith("zh")) continue;
    if (/hant|tw|hk|mo/.test(tag)) return "zh-TW";
    return "zh-CN"; // zh, zh-CN, zh-SG, zh-Hans…
  }
  return "zh-TW";
}

/** Fixed for as long as the page is open: changing it reloads the page. */
export const lang: Lang = chosenLang() ?? deviceLang();
export const simplified = lang === "zh-CN";

export function setLang(next: Lang): void {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    return; // nowhere to remember it, so a reload would only undo it
  }
  if (next !== lang) location.reload();
}

/**
 * Marks text that is data, not wording: a name that is stored, or compared with what is stored.
 * It stays exactly as written in both languages.
 */
export const keep = (text: string): string => text;

if (typeof document !== "undefined") {
  document.documentElement.lang = simplified ? "zh-Hans" : "zh-Hant";
  if (simplified) document.title = "Slate 离线工作区";
}

// ---- what the build puts around the text; not to be called by hand ----

export const __t = (traditional: string, simplifiedText: string): string => (simplified ? simplifiedText : traditional);

/** For text with values in it: `共 ${n} 個` keeps its values and swaps the words around them. */
export const __tt =
  (simplifiedParts: string[]) =>
  (parts: TemplateStringsArray, ...values: unknown[]): string => {
    const words = simplified ? simplifiedParts : parts;
    let out = words[0];
    for (let i = 0; i < values.length; i++) out += String(values[i]) + words[i + 1];
    return out;
  };
