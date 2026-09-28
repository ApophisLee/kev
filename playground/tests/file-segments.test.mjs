import test from "node:test";
import assert from "node:assert/strict";
import { buildFilePatch, editPreview, visibleRanges } from "../src/lib/file-segments.ts";

test("visible ranges use absolute Unicode character offsets and include each newline", () => {
  const text = "😀 first\n二行\nlast";
  const start = 17;
  const end = start + Array.from(text).length;
  const ranges = visibleRanges({ text, start, end });
  assert.deepEqual(Object.fromEntries(Object.entries(ranges).filter(([key]) => key === "current_view" || key.startsWith("line_"))), {
    current_view: { start: 17, end: 32 },
    line_1: { start: 17, end: 25 },
    line_2: { start: 25, end: 28 },
    line_3: { start: 28, end: 32 },
  });
  const chars = Array.from(text);
  assert.equal(chars.slice(ranges.line_1.start - start, ranges.line_1.end - start).join(""), "😀 first\n");
  assert.equal(chars.slice(ranges.line_2.start - start, ranges.line_2.end - start).join(""), "二行\n");
  for (const range of Object.values(ranges)) {
    assert.ok(range.start >= start && range.start <= range.end && range.end <= end);
  }
});

test("single-line views deduplicate the entire view, and empty views do not invent lines", () => {
  for (const text of ["one line", "one line\n", "🌏", ""]) {
    const end = 5 + Array.from(text).length;
    const ranges = visibleRanges({ text, start: 5, end });
    assert.deepEqual(ranges.current_view, { start: 5, end });
    assert.equal(ranges.line_1, undefined);
    assert.equal(new Set(Object.values(ranges).map(({ start, end }) => `${start}:${end}`)).size, Object.keys(ranges).length);
    if (text.length === 0) assert.deepEqual(ranges, { current_view: { start: 5, end } });
  }
  const newlineRanges = visibleRanges({ text: "\n\n", start: 4, end: 6 });
  assert.deepEqual(Object.fromEntries(Object.entries(newlineRanges).filter(([key]) => key === "current_view" || key.startsWith("line_"))), {
    current_view: { start: 4, end: 6 },
    line_1: { start: 4, end: 5 },
    line_2: { start: 5, end: 6 },
  });
});

test("only the first 16 line choices are exposed while current_view covers the complete reading", () => {
  const text = Array.from({ length: 20 }, (_, index) => `line ${index + 1}\n`).join("");
  const ranges = visibleRanges({ text, start: 0, end: Array.from(text).length });
  assert.ok(Object.keys(ranges).length <= 40);
  assert.ok(Object.keys(ranges).some((key) => key.startsWith("token_")));
  assert.ok(Object.keys(ranges).some((key) => key.startsWith("char_")));
  assert.equal(ranges.line_17, undefined);
  assert.equal(text.slice(ranges.line_16.start, ranges.line_16.end), "line 16\n");
  assert.deepEqual(ranges.current_view, { start: 0, end: text.length });
});

test("single-line code offers individual characters and short lexical ranges", () => {
  const text = "print(1 + 12)";
  const start = 10;
  const ranges = visibleRanges({ text, start, end: start + text.length });
  const offsets = new Set(Object.values(ranges).map(({ start, end }) => `${start}:${end}`));
  for (let index = 0; index < text.length; index++) {
    assert.ok(offsets.has(`${start + index}:${start + index + 1}`), `character ${index} remains individually editable`);
  }
  const tokens = Object.values(ranges).map((range) => text.slice(range.start - start, range.end - start));
  for (const token of ["print", "(", "1", " ", "+", "12", ")"]) assert.ok(tokens.includes(token));
  assert.equal(offsets.size, Object.keys(ranges).length);
});

test("focused readings retain all character ranges and every insertion point within 40 options", () => {
  const examples = ["print()", "abcdefghijklmnop", "a\n".repeat(8), "\n".repeat(16), "😀_二(🌏)", "x", ""];
  for (const text of examples) {
    const length = Array.from(text).length;
    const start = 20;
    const ranges = visibleRanges({ text, start, end: start + length });
    const offsets = new Set(Object.values(ranges).map(({ start, end }) => `${start}:${end}`));
    assert.ok(Object.keys(ranges).length <= 40);
    assert.equal(offsets.size, Object.keys(ranges).length);
    for (let index = 0; index <= length; index++) {
      assert.ok(offsets.has(`${start + index}:${start + index}`), `insertion at ${index} in ${JSON.stringify(text)}`);
      if (length > 0) assert.deepEqual(ranges[`insert_at_${start + index}`], { start: start + index, end: start + index });
      if (index < length) assert.ok(offsets.has(`${start + index}:${start + index + 1}`), `replacement at ${index}`);
    }
  }
});

test("insertion cursors add literal text inside closed calls without replacing characters", () => {
  const reading = { text: "print()", start: 0, end: 7 };
  const range = visibleRanges(reading).insert_at_6;
  assert.deepEqual(range, { start: 6, end: 6 });
  assert.equal(buildFilePatch(reading.text, range.start, range.end, "1", 40).content, "print(1)");
  const preview = editPreview(reading, range, "1");
  assert.equal(preview.removed, "");
  assert.equal(preview.before, "print()");
  assert.equal(preview.after, "print(1)");

  const unicodeReading = { text: "😀(🌏)", start: 10, end: 14 };
  const unicodeRange = visibleRanges(unicodeReading).insert_at_12;
  assert.deepEqual(unicodeRange, { start: 12, end: 12 });
  assert.equal(editPreview(unicodeReading, unicodeRange, "二").after, "😀(二🌏)");
});

test("fine ranges count Unicode code points and remain bounded for long readings", () => {
  const text = "😀 二行12 = 42\n";
  const characters = Array.from(text);
  const start = 7;
  const ranges = visibleRanges({ text, start, end: start + characters.length });
  const offsets = new Set(Object.values(ranges).map(({ start, end }) => `${start}:${end}`));
  for (let index = 0; index < characters.length; index++) assert.ok(offsets.has(`${start + index}:${start + index + 1}`));
  assert.ok(Object.values(ranges).some((range) => characters.slice(range.start - start, range.end - start).join("") === "二行12"));
  for (const source of ["a".repeat(300), "a + 1\n".repeat(50), "😀".repeat(300)]) {
    const result = visibleRanges({ text: source, start: 15, end: 15 + Array.from(source).length });
    assert.ok(Object.keys(result).length <= 40);
    assert.equal(new Set(Object.values(result).map(({ start, end }) => `${start}:${end}`)).size, Object.keys(result).length);
    for (const [key, range] of Object.entries(result)) {
      assert.ok(range.start >= 15 && range.end <= 15 + Array.from(source).length);
      if (key.startsWith("token_")) assert.ok(range.end - range.start <= 20);
      if (key.startsWith("char_")) assert.equal(range.end - range.start, 1);
    }
  }
});

test("previews expose the exact removed text and execution result for short edits", () => {
  const reading = { text: "print(1", start: 30, end: 37 };
  assert.deepEqual(editPreview(reading, { start: 30, end: 37 }, ")\n"), {
    start: 30, end: 37, removed: "print(1", before: "print(1", after: ")\n",
    preview_start: 30, preview_end: 37, after_preview_end: 32,
    clipped_before: false, clipped_after: false, after_clipped: false, removed_clipped: false,
  });
  const insertion = editPreview(reading, { start: 37, end: 37 }, " + 1)\n");
  assert.equal(insertion.removed, "");
  assert.equal(insertion.after, "print(1 + 1)\n");
  assert.equal(insertion.after, buildFilePatch(reading.text, 7, 7, " + 1)\n", 40).content);
});

test("preview offsets, insertion, and deletion use the executor's Unicode semantics", () => {
  const reading = { text: "A😀B🌏C", start: 10, end: 15 };
  for (const [start, end, fragment] of [[11, 12, "🚀"], [12, 12, "二"], [11, 14, ""]]) {
    const preview = editPreview(reading, { start, end }, fragment);
    assert.equal(preview.after, buildFilePatch(reading.text, start - 10, end - 10, fragment, 400).content);
    assert.equal(preview.removed, Array.from(reading.text).slice(start - 10, end - 10).join(""));
    assert.equal(preview.after_preview_end, reading.start + Array.from(preview.after).length);
  }
});

test("large previews are bounded contiguous excerpts and mark every omission", () => {
  const text = "😀".repeat(140) + "OLD".repeat(50) + "尾".repeat(160);
  const reading = { text, start: 20, end: 20 + Array.from(text).length };
  const preview = editPreview(reading, { start: 160, end: 310 }, "新".repeat(200));
  assert.equal(Array.from(preview.before).length, 100);
  assert.equal(Array.from(preview.after).length, 100);
  assert.equal(Array.from(preview.removed).length, 80);
  assert.equal(preview.preview_start, 120);
  assert.equal(preview.preview_end, 220);
  assert.equal(preview.after_preview_end, 220);
  assert.equal(preview.clipped_before, true);
  assert.equal(preview.clipped_after, true);
  assert.equal(preview.after_clipped, true);
  assert.equal(preview.removed_clipped, true);
  const patched = buildFilePatch(text, 140, 290, "新".repeat(200), 400).content;
  assert.equal(preview.before, Array.from(text).slice(100, 200).join(""));
  assert.equal(preview.after, Array.from(patched).slice(100, 200).join(""));
  assert.equal(preview.removed, Array.from(text).slice(140, 220).join(""));
});

test("previews reject ranges outside the visible reading and invalid fragments", () => {
  const reading = { text: "A😀B", start: 10, end: 13 };
  for (const range of [{ start: 9, end: 11 }, { start: 11, end: 14 }, { start: 12, end: 11 }, { start: 10.5, end: 11 }]) {
    assert.throws(() => editPreview(reading, range, "x"), /edit range/);
  }
  assert.throws(() => editPreview({ ...reading, end: 14 }, { start: 10, end: 11 }, "x"), /Reading/);
  assert.throws(() => editPreview(reading, { start: 10, end: 11 }, "\0"), /without NUL/);
  assert.throws(() => editPreview(reading, { start: 10, end: 11 }, "x".repeat(401)), /exceeds/);
});

test("reading ranges reject invalid or inconsistent character positions", () => {
  for (const reading of [
    { text: "x", start: -1, end: 0 },
    { text: "x", start: 2, end: 1 },
    { text: "x", start: 0.5, end: 1.5 },
    { text: "x", start: 0, end: Infinity },
    { text: "🌏", start: 0, end: 2 },
    { text: 12, start: 0, end: 2 },
  ]) assert.throws(() => visibleRanges(reading), /Reading/);
});

test("patching a Unicode segment preserves every character outside its range", () => {
  const source = "prefix 😀\nOLD\n尾端 🚀";
  const chars = Array.from(source);
  const start = chars.indexOf("O");
  const end = start + 3;
  const patch = buildFilePatch(source, start, end, "新🌏", 2);
  assert.deepEqual(patch, {
    content: "prefix 😀\n新🌏\n尾端 🚀",
    start, end, insertedChars: 2, totalChars: chars.length - 1,
  });
  const changed = Array.from(patch.content);
  assert.deepEqual(changed.slice(0, start), chars.slice(0, start));
  assert.deepEqual(changed.slice(start + patch.insertedChars), chars.slice(end));
});

test("empty fragments delete ranges; zero-width ranges insert or leave the file unchanged", () => {
  assert.deepEqual(buildFilePatch("A😀B", 1, 2, "", 1), {
    content: "AB", start: 1, end: 2, insertedChars: 0, totalChars: 2,
  });
  assert.equal(buildFilePatch("A😀B", 1, 1, "🌏", 1).content, "A🌏😀B");
  assert.equal(buildFilePatch("A😀B", 3, 3, "!", 1).content, "A😀B!");
  assert.equal(buildFilePatch("A😀B", 0, 0, "", 1).content, "A😀B");
  assert.equal(buildFilePatch("A😀B", 0, 3, "", 1).content, "");
  assert.equal(buildFilePatch("", 0, 0, "new", 3).content, "new");
});

test("patch validation rejects invalid offsets, limits, NUL, and oversized fragments", () => {
  for (const [start, end] of [[-1, 1], [2, 1], [0, 4], [0.5, 1], [0, NaN], [0, Infinity], ["0", 1]]) {
    assert.throws(() => buildFilePatch("A😀B", start, end, "x", 1), /edit range/);
  }
  for (const limit of [0, -1, 401, 1.5, NaN, "2"]) {
    assert.throws(() => buildFilePatch("abc", 0, 1, "x", limit), /fragment limit/);
  }
  assert.throws(() => buildFilePatch("abc", 0, 1, "a\0b", 3), /without NUL/);
  assert.throws(() => buildFilePatch("abc", 0, 1, null, 3), /without NUL/);
  assert.throws(() => buildFilePatch("abc", 0, 1, "🌏🌏", 1), /exceeds/);
  assert.throws(() => buildFilePatch(null, 0, 0, "x", 1), /source/);
  assert.equal(buildFilePatch("abc", 0, 1, "🌏".repeat(400), 400).insertedChars, 400);
});
