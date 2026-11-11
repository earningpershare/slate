// A small, safe expression language for database formula properties.
// No eval: a hand-written tokenizer + recursive-descent parser.
import dayjs from "dayjs";

export type FValue = number | string | boolean;

type Tok = { t: "num" | "str" | "id" | "op" | "end"; v: string };

const OPS = ["==", "!=", ">=", "<=", "&&", "||", "+", "-", "*", "/", "%", ">", "<", "!", "(", ")", ","];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ t: "num", v: src.slice(i, j) });
      i = j;
    } else if (c === '"' || c === "'" || c === "“" || c === "「") {
      const close = c === "“" ? "”" : c === "「" ? "」" : c;
      const j = src.indexOf(close, i + 1);
      if (j < 0) throw new Error("字串沒有結尾的引號");
      out.push({ t: "str", v: src.slice(i + 1, j) });
      i = j + 1;
    } else {
      const op = OPS.find((o) => src.startsWith(o, i));
      if (op) {
        out.push({ t: "op", v: op });
        i += op.length;
      } else {
        let j = i;
        while (j < src.length && !/[\s()+\-*/%,<>=!&|"']/.test(src[j])) j++;
        if (j === i) throw new Error(`看不懂的符號「${c}」`);
        out.push({ t: "id", v: src.slice(i, j) });
        i = j;
      }
    }
  }
  out.push({ t: "end", v: "" });
  return out;
}

const num = (v: FValue): number => {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : 0;
};
const str = (v: FValue): string => (typeof v === "boolean" ? (v ? "true" : "false") : String(v));
const truthy = (v: FValue): boolean => (typeof v === "string" ? v !== "" : !!v);

const FUNCS: Record<string, (a: FValue[]) => FValue> = {
  round: ([x, d = 0]) => {
    const m = 10 ** num(d);
    return Math.round(num(x) * m) / m;
  },
  floor: ([x]) => Math.floor(num(x)),
  ceil: ([x]) => Math.ceil(num(x)),
  abs: ([x]) => Math.abs(num(x)),
  min: (a) => Math.min(...a.map(num)),
  max: (a) => Math.max(...a.map(num)),
  concat: (a) => a.map(str).join(""),
  length: ([x]) => str(x).length,
  contains: ([a, b]) => str(a).includes(str(b)),
  empty: ([x]) => !truthy(x),
  toNumber: ([x]) => num(x),
  format: ([x]) => str(x),
  upper: ([x]) => str(x).toUpperCase(),
  lower: ([x]) => str(x).toLowerCase(),
  now: () => dayjs().format("YYYY-MM-DD HH:mm"),
  today: () => dayjs().format("YYYY-MM-DD"),
  /** whole days from b to a (a - b) */
  dateBetween: ([a, b]) => {
    if (!str(a) || !str(b)) return 0;
    return dayjs(str(a)).startOf("day").diff(dayjs(str(b)).startOf("day"), "day");
  },
  dateAdd: ([d, n, unit = "days"]) =>
    str(d) ? dayjs(str(d)).add(num(n), str(unit) as dayjs.ManipulateType).format("YYYY-MM-DD") : "",
};

export const FORMULA_FUNCTIONS = ["prop", "if", ...Object.keys(FUNCS)];

class Parser {
  private i = 0;
  constructor(
    private toks: Tok[],
    private get: (name: string) => FValue,
  ) {}

  private peek = () => this.toks[this.i];
  private eat(v?: string): Tok {
    const t = this.toks[this.i];
    if (v !== undefined && t.v !== v) throw new Error(`這裡應該是「${v}」`);
    this.i++;
    return t;
  }
  private isOp = (...vs: string[]) => this.peek().t === "op" && vs.includes(this.peek().v);
  private isWord = (w: string) => this.peek().t === "id" && this.peek().v === w;

  parse(): FValue {
    const v = this.or();
    if (this.peek().t !== "end") throw new Error(`多出了「${this.peek().v}」`);
    return v;
  }
  private or(): FValue {
    let l = this.and();
    while (this.isOp("||") || this.isWord("or")) {
      this.eat();
      const r = this.and();
      l = truthy(l) || truthy(r);
    }
    return l;
  }
  private and(): FValue {
    let l = this.cmp();
    while (this.isOp("&&") || this.isWord("and")) {
      this.eat();
      const r = this.cmp();
      l = truthy(l) && truthy(r);
    }
    return l;
  }
  private cmp(): FValue {
    const l = this.add();
    if (!this.isOp("==", "!=", ">", "<", ">=", "<=")) return l;
    const op = this.eat().v;
    const r = this.add();
    const bothNum = typeof l === "number" && typeof r === "number";
    const c = bothNum ? (l as number) - (r as number) : str(l).localeCompare(str(r));
    switch (op) {
      case "==":
        return c === 0;
      case "!=":
        return c !== 0;
      case ">":
        return c > 0;
      case "<":
        return c < 0;
      case ">=":
        return c >= 0;
      default:
        return c <= 0;
    }
  }
  private add(): FValue {
    let l = this.mul();
    while (this.isOp("+", "-")) {
      const op = this.eat().v;
      const r = this.mul();
      if (op === "+") l = typeof l === "string" || typeof r === "string" ? str(l) + str(r) : num(l) + num(r);
      else l = num(l) - num(r);
    }
    return l;
  }
  private mul(): FValue {
    let l = this.unary();
    while (this.isOp("*", "/", "%")) {
      const op = this.eat().v;
      const r = num(this.unary());
      l = op === "*" ? num(l) * r : op === "/" ? num(l) / r : num(l) % r;
    }
    return l;
  }
  private unary(): FValue {
    if (this.isOp("-")) {
      this.eat();
      return -num(this.unary());
    }
    if (this.isOp("!") || this.isWord("not")) {
      this.eat();
      return !truthy(this.unary());
    }
    return this.primary();
  }
  private primary(): FValue {
    const t = this.eat();
    if (t.t === "num") {
      const n = Number(t.v);
      if (!Number.isFinite(n)) throw new Error(`「${t.v}」不是數字`);
      return n;
    }
    if (t.t === "str") return t.v;
    if (t.t === "op" && t.v === "(") {
      const v = this.or();
      this.eat(")");
      return v;
    }
    if (t.t === "id") {
      if (t.v === "true") return true;
      if (t.v === "false") return false;
      if (!this.isOp("(")) throw new Error(`不認得「${t.v}」，屬性請寫成 prop("${t.v}")`);
      this.eat("(");
      const args: FValue[] = [];
      if (!this.isOp(")")) {
        do args.push(this.or());
        while (this.isOp(",") && this.eat());
      }
      this.eat(")");
      if (t.v === "prop") return this.get(str(args[0] ?? ""));
      if (t.v === "if") return truthy(args[0] ?? false) ? (args[1] ?? "") : (args[2] ?? "");
      const fn = FUNCS[t.v];
      if (!fn) throw new Error(`沒有「${t.v}」這個函式`);
      return fn(args);
    }
    throw new Error(t.t === "end" ? "公式沒有寫完" : `這裡不能放「${t.v}」`);
  }
}

export type FormulaResult = { ok: true; value: FValue } | { ok: false; error: string };

export function evalFormula(src: string, get: (name: string) => FValue): FormulaResult {
  if (!src.trim()) return { ok: true, value: "" };
  try {
    const value = new Parser(tokenize(src), get).parse();
    if (typeof value === "number" && !Number.isFinite(value)) return { ok: false, error: "結果不是有效的數字（是否除以 0？）" };
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "公式有誤" };
  }
}
