/**
 * The `insert_blocks` refusal classes and the display line for an edit
 * failure, shared by every transport (#88). The HTTP server and the Tauri
 * client build the same text from the engine's stderr and attach the class
 * as a structured field, so the editor picks its sentence from the field and
 * never from message text.
 *
 * Only the engine's FIRST `Error:` line is classified, and each class is
 * matched on that line's fixed head and fixed tail (measured on ahwp 1.6.1),
 * so a value the user typed (an anchor, a style name) can sit inside a line
 * but cannot choose a class. The engine writes these diagnostics in Korean
 * under every locale, so the markers are Korean and permanent.
 */

/** The class of an `insert_blocks` refusal, with what the engine measured. */
export type InsertionRefusal =
  | { kind: "layout_overflow"; blockMm?: number; insertionMm?: number }
  | { kind: "unknown_style"; style: string }
  | { kind: "invalid_definition" };

/** The engine's first `Error:` line: each refusal is one anyhow line. */
function firstErrorLine(stderr: string): string | undefined {
  return stderr.split(/\r?\n/u).find(line => line.startsWith("Error: "));
}

/**
 * insert_blocks.rs:374. The name runs greedily between the fixed head and the
 * fixed tail, so a name holding `'` or the tail's own words stays whole and a
 * line that only embeds the sentence (an add_table anchor) does not match.
 */
const UNKNOWN_STYLE_LINE =
  /^Error: 스타일 '(.+)'을 대상 문서에서 찾을 수 없습니다\. styles 정의를 제공하고 missing_style=create로 다시 시도하거나 hwp styles에서 기존 스타일을 선택하세요$/u;

/**
 * insert_blocks.rs:497: the fixed head, the validation issue list
 * (document_spec.rs Display: `code at path: message` joined by `; `), and the
 * fixed tail that names the insertion point's width.
 */
const INVALID_DEFINITION_LINE =
  /^Error: insert_blocks 블록\/스타일\/목록 정의가 유효하지 않습니다: (.*)\. DocumentSpec v1 정의를 수정한 뒤 다시 시도하세요 \(삽입 위치의 폭은 (\d+(?:\.\d+)?)mm입니다\)$/u;

/**
 * A layout_overflow issue from document_spec.rs, as its own entry in the
 * `; `-joined list: the path is the spec's own (`$.sections[...]`), never a
 * style name's, and the message is one of the engine's two width messages:
 * - :1495, columns: `column widths total X mm; body width is Y mm`
 * - :1503 and the image check: `... exceeds body width Y mm`
 * Y is the width the block was measured against: the body, or a cell's
 * content width for a block inside a table cell (:1568-1580), which differs
 * from the insertion point's width in the line's tail.
 *
 * The issue list joins entries with `; ` and paths can carry user style
 * names (document_spec.rs:506-517), so a name holding `; layout_overflow at
 * $.sections[...]` can still forge an entry. Only machine-readable refusal
 * codes from the engine close that; it waits on STAIxBWLB/agent-hwp#531.
 */
const OVERFLOW_ENTRY =
  /(?:^|; )layout_overflow at (\$\.sections\[[^\s:;]*): (?:column widths total (\d+(?:\.\d+)?) mm; body width is (\d+(?:\.\d+)?) mm|[^;]*? exceeds body width (\d+(?:\.\d+)?) mm)(?=; |$)/gu;

function positive(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The class an `insert_blocks` refusal's stderr names, or undefined when it
 * is not one of the three.
 */
export function classifyInsertionRefusal(stderr: string): InsertionRefusal | undefined {
  const line = firstErrorLine(stderr);
  if (line === undefined) return undefined;
  const style = UNKNOWN_STYLE_LINE.exec(line)?.[1];
  if (style !== undefined && style.trim() !== "") return { kind: "unknown_style", style };
  const definition = INVALID_DEFINITION_LINE.exec(line);
  if (definition === null) return undefined;
  const entries = [...definition[1]!.matchAll(OVERFLOW_ENTRY)];
  if (entries.length === 0) return { kind: "invalid_definition" };
  // Widths come from one issue: the column-sum entry when there is one
  // (it names both), else the first overflow entry. The tail's insertion
  // width is only a fallback, because a block in a cell is measured against
  // the cell, not the insertion point.
  const entry = entries.find(match => match[2] !== undefined) ?? entries[0]!;
  const blockMm = positive(entry[2]);
  // The tail is a fallback only when the entry printed no width at all: a
  // printed 0.00 mm (a cell narrower than its margins, document_spec.rs:1570)
  // is the measurement, so it leaves insertionMm unset rather than borrowing
  // the insertion point's width.
  const printed = entry[3] ?? entry[4];
  const insertionMm = printed === undefined ? positive(definition[2]) : positive(printed);
  return {
    kind: "layout_overflow",
    ...(blockMm === undefined ? {} : { blockMm }),
    ...(insertionMm === undefined ? {} : { insertionMm }),
  };
}

/**
 * Narrow an untrusted value (a wire field, a host error) to an insertion
 * class: a known kind, a non-blank style, and positive finite widths when
 * present. Anything else is no class at all.
 */
export function isInsertionRefusal(value: unknown): value is InsertionRefusal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  const optionalMm = (key: string): boolean => {
    const mm = rec[key];
    return mm === undefined || (typeof mm === "number" && Number.isFinite(mm) && mm > 0);
  };
  switch (rec.kind) {
    case "layout_overflow":
      return optionalMm("blockMm") && optionalMm("insertionMm");
    case "unknown_style":
      return typeof rec.style === "string" && rec.style.trim() !== "";
    case "invalid_definition":
      return true;
    default:
      return false;
  }
}

/** Extensions a staged or user path ends with; a path with spaces runs to one. */
const PATH_END = String.raw`\.(?:hwpx|hwp|json|png|jpe?g|gif|bmp|svg|pdf|md|txt|xml|hwpt)\b`;
const PATH_ROOT = String.raw`(?:[A-Za-z]:[\\/]|\/)`;

/**
 * Text the engine wrote, with no path in it: the given work dir first, then
 * absolute paths, POSIX or Windows. A path may hold spaces
 * (`/Users/a b/Library/x/in.hwpx`, `C:\Users\a b\x.hwpx`), so a quoted path
 * is redacted through its closing quote, one that reaches a known file
 * extension through its file name, and any other through its first space.
 * A replacement fires only where a path can start, so a Korean diagnostic's
 * own `블록/스타일/목록` slashes survive.
 */
export function withoutPaths(text: string, workDir?: string): string {
  const withoutWorkDir = workDir === undefined || workDir === "" ? text : text.split(workDir).join("<work dir>");
  return withoutWorkDir
    .replace(new RegExp(String.raw`(["'])${PATH_ROOT}[^"'\n]*\1`, "gu"), "$1<path>$1")
    .replace(new RegExp(String.raw`(^|[\s(\[{:])${PATH_ROOT}[^\n"']*?${PATH_END}`, "gu"), "$1<path>")
    .replace(new RegExp(String.raw`(^|[\s(\[{:])${PATH_ROOT}[^\s"')\]}]*`, "gu"), "$1<path>");
}

/**
 * The one-line cause of an `insert_blocks` refusal, for a log or a host that
 * reads text: the class with its measurements, or the engine's own `Error:`
 * line with paths replaced. Every transport writes the same line.
 */
export function insertionRefusalLine(stderr: string, workDir?: string): string {
  const refusal = classifyInsertionRefusal(stderr);
  if (refusal?.kind === "unknown_style") {
    // Last on the line: a style name is user text and can hold `)` or `'`.
    return `insert_blocks refused: unknown_style; ${refusal.style}`;
  }
  if (refusal?.kind === "invalid_definition") return "insert_blocks refused: invalid_definition";
  if (refusal?.kind === "layout_overflow") {
    const mm = (value: number): string => value.toFixed(2);
    const widths = [
      ...(refusal.blockMm === undefined ? [] : [`block ${mm(refusal.blockMm)} mm`]),
      ...(refusal.insertionMm === undefined ? [] : [`insertion point ${mm(refusal.insertionMm)} mm`]),
    ];
    return `insert_blocks refused: layout_overflow${widths.length === 0 ? "" : ` (${widths.join(", ")})`}`;
  }
  const reason = engineLine(stderr, workDir).replace(/^insert_blocks\s+/u, "");
  return reason === "" ? "insert_blocks refused" : `insert_blocks refused: ${reason}`;
}

/** The engine's first `Error:` line (or first non-empty line), paths removed. */
function engineLine(stderr: string, workDir?: string): string {
  const line = firstErrorLine(stderr) ??
    stderr.split(/\r?\n/u).map(entry => entry.trim()).find(entry => entry !== "") ?? "";
  return withoutPaths(line.replace(/^Error:\s*/u, "").trim(), workDir);
}

/** The step every unclassified edit failure ends with (#88). */
export const UNCLASSIFIED_EDIT_STEP = "Fix or remove the pending edit it names, then apply again.";

/**
 * An edit failure no classifier recognised, as both transports print it: the
 * engine's own first `Error:` line with paths removed, then the step; the
 * step alone when the engine printed no `Error:` line. Display text only;
 * nothing classifies from it. The full stderr stays on the error for a log.
 */
export function unclassifiedEditLine(stderr: string, workDir?: string): string {
  // Only a line the engine marked as its error: other output (progress,
  // stdout chatter) stays off the message, as runCliOk always kept it.
  const line = firstErrorLine(stderr);
  const reason = line === undefined
    ? ""
    : withoutPaths(line.replace(/^Error:\s*/u, "").trim(), workDir).replace(/[.:\s]+$/u, "");
  return reason === "" ? UNCLASSIFIED_EDIT_STEP : `${reason}. ${UNCLASSIFIED_EDIT_STEP}`;
}

/**
 * What an edit failure with empty stderr means, after the exit line. `hwp
 * edit` always writes to stderr when it fails, so empty stderr means the
 * process was stopped from outside: killed, out of memory, or a crash with no
 * output. Both transports print this sentence (#88).
 */
export const STOPPED_WITHOUT_DIAGNOSTIC =
  "the engine stopped without writing a diagnostic (most likely it was killed or ran out of memory), " +
  "so nothing was applied. Apply again; if it fails the same way, report it with the host log.";
