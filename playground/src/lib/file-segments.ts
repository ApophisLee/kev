type FileRange = { start: number; end: number };
type VisibleReading = FileRange & { text: string };

function readingCharacters(reading: VisibleReading): string[] {
  if (typeof reading.text !== "string" || !Number.isInteger(reading.start) ||
      !Number.isInteger(reading.end) || reading.start < 0 || reading.end < reading.start) {
    throw new Error("Reading must contain text and a valid character range.");
  }
  const characters = Array.from(reading.text);
  if (reading.end - reading.start !== characters.length) {
    throw new Error("Reading range must match the visible Unicode character count.");
  }
  return characters;
}

// Every offset is measured in Unicode code points, matching the reading cursor.
export function visibleRanges(reading: VisibleReading): Record<string, FileRange> {
  const characters = readingCharacters(reading);
  const ranges: Record<string, FileRange> = {
    current_view: { start: reading.start, end: reading.end },
  };
  const seen = new Set([`${reading.start}:${reading.end}`]);
  const requiredFineRanges = new Set<string>();
  if (characters.length <= 16) {
    for (let offset = reading.start; offset <= reading.end; offset++) {
      requiredFineRanges.add(`${offset}:${offset}`);
      if (offset < reading.end) requiredFineRanges.add(`${offset}:${offset + 1}`);
    }
  }
  const add = (key: string, start: number, end: number) => {
    const signature = `${start}:${end}`;
    const reserved = [...requiredFineRanges].filter((range) => range !== signature && !seen.has(range)).length;
    if (Object.keys(ranges).length + reserved < 40 && !seen.has(signature)) {
      ranges[key] = { start, end };
      seen.add(signature);
    }
  };
  const addCursor = (offset: number) => add(`insert_at_${offset}`, offset, offset);
  addCursor(reading.start);
  addCursor(reading.end);
  let lineStart = 0;
  let lineNumber = 1;
  const addLine = (end: number) => {
    const start = reading.start + lineStart;
    const absoluteEnd = reading.start + end;
    add(`line_${lineNumber}`, start, absoluteEnd);
    lineStart = end;
    lineNumber++;
  };
  for (let index = 0; index < characters.length && lineNumber <= 16; index++) {
    if (characters[index] === "\n") addLine(index + 1);
  }
  if (lineStart < characters.length && lineNumber <= 16) addLine(characters.length);
  // In a focused view, reserve every insertion point and every single-character
  // replacement before adding optional lexical spans. A cursor removes no text.
  if (characters.length <= 16) {
    for (let index = 0; index <= characters.length; index++) {
      addCursor(reading.start + index);
      if (index < characters.length) add(`char_${index + 1}`, reading.start + index, reading.start + index + 1);
    }
  }

  // Short lexical pieces and individual characters keep a one-line reading from
  // forcing a whole-line replacement. Long runs are split into small spans.
  const tokens: FileRange[] = [];
  for (let start = 0; start < characters.length;) {
    const first = characters[start];
    const continuation = /[\p{L}\p{M}_]/u.test(first) ? /[\p{L}\p{M}\p{N}_]/u
      : /\p{N}/u.test(first) ? /\p{N}/u : /\s/u.test(first) ? /\s/u : null;
    let end = start + 1;
    while (continuation && end < characters.length && end - start < 20 && continuation.test(characters[end])) end++;
    tokens.push({ start: reading.start + start, end: reading.start + end });
    start = end;
  }
  // Interleave token and character choices so neither consumes the entire
  // bounded dictionary. Read a shorter view to focus on another fine range.
  for (let index = 0; index < Math.max(tokens.length, characters.length) && Object.keys(ranges).length < 40; index++) {
    const token = tokens[index];
    if (token) add(`token_${index + 1}`, token.start, token.end);
    if (index < characters.length) {
      add(`char_${index + 1}`, reading.start + index, reading.start + index + 1);
      addCursor(reading.start + index);
    }
  }
  return ranges;
}

export function editPreview(reading: VisibleReading, range: FileRange, fragment: string) {
  const characters = readingCharacters(reading);
  const start = range.start - reading.start;
  const end = range.end - reading.start;
  // Use the executor's splice and validation, operating only on already read
  // text. A range extending outside that reading is rejected by buildFilePatch.
  const patch = buildFilePatch(reading.text, start, end, fragment, 400);
  const after = Array.from(patch.content);
  const previewStart = Math.max(0, start - 40);
  const previewEnd = Math.min(characters.length, previewStart + 100);
  const afterPreviewEnd = Math.min(after.length, previewStart + 100);
  return {
    start: range.start,
    end: range.end,
    removed: characters.slice(start, Math.min(end, start + 80)).join(""),
    before: characters.slice(previewStart, previewEnd).join(""),
    after: after.slice(previewStart, afterPreviewEnd).join(""),
    preview_start: reading.start + previewStart,
    preview_end: reading.start + previewEnd,
    after_preview_end: reading.start + afterPreviewEnd,
    clipped_before: previewStart > 0,
    clipped_after: previewEnd < characters.length,
    after_clipped: afterPreviewEnd < after.length,
    removed_clipped: end - start > 80,
  };
}

export function buildFilePatch(
  source: string, start: number, end: number, fragment: string, limit: number,
): { content: string; start: number; end: number; insertedChars: number; totalChars: number } {
  if (typeof source !== "string") throw new Error("File source must be a string.");
  const characters = Array.from(source);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > characters.length) {
    throw new Error("File edit range must use integer character offsets within the source.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 400) {
    throw new Error("File fragment limit must be an integer from 1 to 400 characters.");
  }
  if (typeof fragment !== "string" || fragment.includes("\0")) {
    throw new Error("File fragment must be a string without NUL.");
  }
  const insertedChars = Array.from(fragment).length;
  if (insertedChars > limit) throw new Error(`File fragment exceeds the ${limit}-character limit.`);
  return {
    content: characters.slice(0, start).join("") + fragment + characters.slice(end).join(""),
    start,
    end,
    insertedChars,
    totalChars: characters.length - (end - start) + insertedChars,
  };
}
