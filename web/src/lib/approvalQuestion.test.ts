import { describe, expect, it } from "vitest";
import { selectedNumbers, splitQuestion, toggleOptionNumber } from "./approvalQuestion";

// 真实样本：rpiv-ask-user-question 在 RPC 模式下用它当 ui.input 的标题
const MULTI_TITLE = [
  "[集成测试] 第一批 Testcontainers 集成测试，你想先盖哪几个？（可多选）",
  "",
  "1. Flyway 迁移能干净跑通 — 在一个干净容器里从 V1 跑到 V2",
  "2. 唯一索引冲突 → 业务异常 — 并发射入同名 username/email 时真库抛 DuplicateKeyException",
  "3. 分页 + 排序 SQL 正确性 — 真库验证 count 语句与 order by",
  "4. MPJ 联表查角色 — 验证 innerJoin + selectAs 能正确投射",
  "",
  'Enter the numbers of all that apply, comma-separated (e.g. "1,3").',
].join("\n");

describe("splitQuestion", () => {
  it("把编号选项从标题里拆出来，正文只留问题与说明", () => {
    const { question, options } = splitQuestion(MULTI_TITLE);
    expect(options).toHaveLength(4);
    expect(options[0]).toEqual({
      n: 1,
      label: "Flyway 迁移能干净跑通",
      desc: "在一个干净容器里从 V1 跑到 V2",
    });
    expect(options[3].label).toBe("MPJ 联表查角色");
    expect(question).toContain("[集成测试] 第一批 Testcontainers");
    expect(question).toContain('Enter the numbers of all that apply');
    expect(question).not.toContain("2. 唯一索引冲突");
    // 抽走四行后不该留下成片的空行
    expect(question).not.toMatch(/\n{3,}/);
  });

  it("没有编号行时原样返回", () => {
    const title = "你的名字是什么？";
    expect(splitQuestion(title)).toEqual({ question: title, options: [] });
  });

  it("单条编号、或编号不连续时不当作选项", () => {
    const single = "只能选一个：\n1. 甲 — 说明";
    expect(splitQuestion(single)).toEqual({ question: single, options: [] });

    const gap = "列表：\n1. 甲 — 说明\n3. 丙 — 说明";
    expect(splitQuestion(gap).options).toEqual([]);
  });

  it("没有说明的选项整行当标签", () => {
    const { options } = splitQuestion("问题\n1. 甲\n2. 乙");
    expect(options).toEqual([
      { n: 1, label: "甲" },
      { n: 2, label: "乙" },
    ]);
  });

  it("步骤列表也会被识别——这是已知的取舍，点选只往框里填编号，不影响手打", () => {
    const { options } = splitQuestion("按步骤：\n1. 打开设置\n2. 点击 X");
    expect(options.map((o) => o.label)).toEqual(["打开设置", "点击 X"]);
  });
});

describe("selectedNumbers", () => {
  it("认识逗号、中文逗号、空格与带点的编号", () => {
    expect(selectedNumbers("1,3")).toEqual([1, 3]);
    expect(selectedNumbers("1， 3")).toEqual([1, 3]);
    expect(selectedNumbers("2. 4")).toEqual([2, 4]);
    expect(selectedNumbers("")).toEqual([]);
  });

  it("只看分号之前的编号部分", () => {
    expect(selectedNumbers("1,3; 自定义 5 号方案")).toEqual([1, 3]);
  });
});

describe("toggleOptionNumber", () => {
  it("选中后按编号顺序写入", () => {
    expect(toggleOptionNumber("", 3)).toBe("3");
    expect(toggleOptionNumber("3", 1)).toBe("1,3");
    expect(toggleOptionNumber("1,3", 2)).toBe("1,2,3");
  });

  it("再点一次取消", () => {
    expect(toggleOptionNumber("1,3", 3)).toBe("1");
    expect(toggleOptionNumber("1", 1)).toBe("");
  });

  it("保留用户自己写的补充文本", () => {
    expect(toggleOptionNumber("1; 我也想加个灰度开关", 3)).toBe("1,3; 我也想加个灰度开关");
    expect(toggleOptionNumber("1,3; 补充", 1)).toBe("3; 补充");
    // 取消最后一个编号时，只留自定义文本
    expect(toggleOptionNumber("1; 补充", 1)).toBe("补充");
    // 自定义文本里本身带分号时不被截断
    expect(toggleOptionNumber("1; a; b", 2)).toBe("1,2; a; b");
  });
});
