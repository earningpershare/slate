import { describe, expect, it } from "vitest";
import { toSimplified, withSimplified } from "./simplified.mjs";

const through = (code, file = "src/x.tsx") => withSimplified(code, file).code;

describe("the Simplified Chinese build step", () => {
  it("uses the mainland's words, not only its characters", () => {
    expect(toSimplified("匯入檔案")).toBe("导入文件");
    expect(toSimplified("設定與備份")).toBe("设置与备份");
    expect(toSimplified("收件匣")).toBe("收件箱");
    expect(toSimplified("複製檢視")).toBe("复制视图");
    expect(toSimplified("查看任務")).toBe("查看任务"); // the verb stays
    expect(toSimplified("3 筆任務，寫在筆記裡")).toBe("3 条任务，写在笔记里");
  });

  it("gives plain text both forms", () => {
    expect(through(`const a = "設定";`)).toContain(`const a = __t("設定", "设置");`);
    expect(through(`const a = "設定";`)).toMatch(/^import \{ __t, __tt \} from "slate:lang";/);
  });

  it("keeps the values in text that has them", () => {
    expect(through("const a = `共 ${n} 個檔案`;")).toContain('const a = __tt(["共 "," 个文件"])`共 ${n} 個檔案`;');
    // text inside a value is handled too
    expect(through('const a = `${ok ? "完成" : "失敗"}!`;')).toContain('__t("失敗", "失败")');
  });

  it("handles text between tags and in attributes", () => {
    expect(through(`const a = <b title="關閉">匯入</b>;`)).toContain(`<b title={__t("關閉", "关闭")}>{__t("匯入", "导入")}</b>`);
    // lines of text are joined the way JSX joins them
    expect(through("const a = (\n  <p>\n    第一行\n    檔案 <i />\n  </p>\n);")).toContain(`<p>{__t("第一行 檔案 ", "第一行 文件 ")}<i />`);
  });

  it("leaves alone what is not wording", () => {
    const same = (code) => expect(withSimplified(code, "src/x.ts").code).toBe(code);
    same(`const a = keep("繁體中文");`); // marked as data
    same(`type A = "設定" | "檔案";`); // a type
    same(`const a = { "設定": 1 };`); // a key
    same(`const a = /檔案/.test(b);`); // a pattern
    same(`const a = "今天";`); // the same in both
    same(`const a = "settings"; // 設定`); // a comment
  });
});
