import { describe, expect, it } from "vitest";
import { MAX_COLS, MAX_ROWS, parseDelimited } from "./dsvTable";

/** 050: CSV / TSV 解析器（纯函数，无 DOM）。 */

describe("050: parseDelimited", () => {
  it("splits a plain CSV into a header and rows", () => {
    const t = parseDelimited("name,age\nAlice,30\nBob,41", "csv");
    expect(t).not.toBeNull();
    expect(t!.header).toEqual(["name", "age"]);
    expect(t!.rows).toEqual([["Alice", "30"], ["Bob", "41"]]);
    expect(t!.totalRows).toBe(2);
    expect(t!.totalCols).toBe(2);
    expect(t!.truncatedRows).toBe(false);
    expect(t!.truncatedCols).toBe(false);
  });

  it("keeps a quoted field that contains the delimiter", () => {
    const t = parseDelimited('a,b\n"x,y",z', "csv");
    expect(t!.rows).toEqual([["x,y", "z"]]);
  });

  it("keeps a quoted field that contains a newline", () => {
    const t = parseDelimited('a,b\n"line1\nline2",z', "csv");
    expect(t!.rows).toEqual([["line1\nline2", "z"]]);
  });

  it("unescapes a doubled quote", () => {
    const t = parseDelimited('a,b\n"say ""hi""",z', "csv");
    expect(t!.rows).toEqual([['say "hi"', "z"]]);
  });

  it("skips blank lines", () => {
    const t = parseDelimited("a,b\n\n1,2\n\n   \n3,4", "csv");
    expect(t!.rows).toEqual([["1", "2"], ["3", "4"]]);
  });

  it("parses a TSV", () => {
    const t = parseDelimited("name\tage\nAlice\t30", "tsv");
    expect(t!.header).toEqual(["name", "age"]);
    expect(t!.rows).toEqual([["Alice", "30"]]);
  });

  it("falls back to the other delimiter when the tagged one never appears", () => {
    // Models routinely tag a TSV block as csv.
    const t = parseDelimited("name\tage\nAlice\t30", "csv");
    expect(t!.header).toEqual(["name", "age"]);
    expect(t!.rows).toEqual([["Alice", "30"]]);
  });

  it("pads short rows and cuts long rows to the header width", () => {
    const t = parseDelimited("a,b,c\n1,2\n3,4,5,6", "csv");
    expect(t!.rows).toEqual([["1", "2", ""], ["3", "4", "5"]]);
    expect(t!.totalCols).toBe(4);
  });

  it("truncates to 200 rows and reports the total", () => {
    const lines = ["h1,h2"];
    for (let i = 0; i < 300; i++) lines.push("r" + i + ",x");
    const t = parseDelimited(lines.join("\n"), "csv");
    expect(t!.rows.length).toBe(MAX_ROWS);
    expect(t!.totalRows).toBe(300);
    expect(t!.truncatedRows).toBe(true);
  });

  it("truncates to 50 columns and reports it", () => {
    const head = Array.from({ length: 60 }, (_, i) => "c" + i).join(",");
    const t = parseDelimited(head + "\n" + head, "csv");
    expect(t!.header.length).toBe(MAX_COLS);
    expect(t!.totalCols).toBe(60);
    expect(t!.truncatedCols).toBe(true);
  });

  it("returns null when the content carries no delimiter", () => {
    expect(parseDelimited("just one line of prose", "csv")).toBeNull();
    expect(parseDelimited("a\nb\nc", "csv")).toBeNull();
  });

  it("returns null when there is only a header row", () => {
    expect(parseDelimited("a,b", "csv")).toBeNull();
  });
});
