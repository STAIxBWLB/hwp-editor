/**
 * The `insert_blocks` refusal classes and the display line for an edit
 * failure, shared by every transport (#88). The HTTP server and the Tauri
 * client build the same text from the engine's stderr and attach the class
 * as a structured field, so the editor picks its sentence from the field and
 * never from message text.
 *
 * These stderr classifiers are compatibility fallbacks for engines proven
 * below 1.6.3. Modern edit failures use the validated report code and numeric
 * values through reportRefusalFields; they never read this issue list.
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
 * codes from agent-hwp#531 close that on engines >=1.6.3. This reader is
 * restricted to older engines by the transport version gate.
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
/**
 * Where an absolute path can start: a `file://` URL, a UNC root (`//host/`,
 * `\\host\`), a drive root, a POSIX root whose first segment is followed by
 * another `/`, or a single-segment POSIX file with a known extension
 * (`/in.hwpx`). A lone `/` between words (`제목 / 부제`, `수입 / 지출`) or a
 * bare `/word` is user text, not a path (#93): leaving an ambiguous token in
 * place beats swallowing an anchor. A first segment holding Hangul is never
 * a root either (`예산 /항목/세부` is prose, #142). The price is accepted: a
 * path whose first segment is Hangul (`/사용자/a/in.hwpx`) stays unredacted.
 */
const PATH_ROOT = String.raw`(?:file:\/\/\/?|(?<![A-Za-z]:)\/\/(?=[^\s/]+\/)|\\\\(?=[^\s\\]+\\)|[A-Za-z]:[\\/]|\/(?=[^\s/"'\p{Script=Hangul}]+\/)|\/(?=[^\s/"'\p{Script=Hangul}]+${PATH_END}))`;

/**
 * Text the engine wrote, with no path in it: the given work dir first, then
 * absolute paths, POSIX or Windows. A path may hold spaces (`/Users/홍 길동/x`,
 * `C:\Program Files (x86)\x`), so, in order:
 * - a quoted path is redacted through its closing quote;
 * - on a line that opens with one of the engine's file heads (FILE_LINE_HEAD),
 *   where the engine prints `{path}: {error}`, the first path is redacted up
 *   to the next `: ` (a drive's `C:\` has no space after its colon, so it
 *   never ends a path early). Any other line may hold user text before a
 *   later `: `, so the rule does not run there (#142);
 * - one that reaches a known file extension, through its file name;
 * - any other only through its first space, leaving the rest visible. So a
 *   path with a space and no known extension keeps its tail on a line with
 *   no file head even when `: ` follows it (`새 미디어 제거 실패 {dir}: {err}`,
 *   output.rs:1226), and on a file-head line when no `: ` follows; passing
 *   the work dir as workDir closes both (#142 item 2).
 * A replacement fires only where a path can start, so a Korean diagnostic's
 * own `블록/스타일/목록` slashes survive.
 */
export function withoutPaths(text: string, workDir?: string): string {
  const withoutWorkDir = workDir === undefined || workDir === "" ? text : text.split(workDir).join("<work dir>");
  const quoted = withoutWorkDir.replace(new RegExp(String.raw`(["'])${PATH_ROOT}[^"'\n]*\1`, "gu"), "$1<path>$1");
  const colon = FILE_LINE_HEAD.test(quoted)
    ? quoted.replace(new RegExp(String.raw`(^|[\s(\[{:])${PATH_ROOT}[^\n"']*?(?=: )`, "u"), "$1<path>")
    : quoted;
  return colon
    .replace(new RegExp(String.raw`(^|[\s(\[{:])${PATH_ROOT}[^\n"']*?${PATH_END}`, "gu"), "$1<path>")
    .replace(new RegExp(String.raw`(^|[\s(\[{:])${PATH_ROOT}(?:[^\s"')\]}:]|:(?!\s|$))*`, "gu"), "$1<path>")
    // With no `: ` after it, a path with spaces stopped at its first space
    // above; the following words that still hold a separator inside them
    // (`b/c/data`, `Files\Maru`) are its tail. A lone `/`, a word with no
    // separator, and any word holding Hangul stay: an ambiguous token is left.
    .replace(/<path>(?: [^\s"'/\\\p{Script=Hangul}]+[/\\](?:[^\s"'\p{Script=Hangul}:]|:(?!\s|$))*)+/gu, "<path>");
}

/**
 * What a failure whose stderr names no `Error:` line means (a Rust panic, or
 * output the engine never marked as its error): a cause class and the next
 * step, never the bare step and never a progress line (#93).
 */
export const NO_ENGINE_CAUSE =
  "the engine failed without naming a cause (most likely it crashed), so nothing was applied. " +
  "Apply again; if it fails the same way, report it with the host log.";

/**
 * The one-line cause of an `insert_blocks` refusal, for a log or a host that
 * reads text: the class with its measurements, or the engine's own `Error:`
 * line with paths replaced. Every transport writes the same line. With no
 * `Error:` line it names no engine text at all: the first other line is
 * likely progress output, not the cause (#93).
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
  const reason = engineErrorReason(stderr, workDir)?.replace(/^insert_blocks\s+/u, "");
  return reason === undefined || reason === "" ? `insert_blocks refused: ${NO_ENGINE_CAUSE}` : `insert_blocks refused: ${reason}`;
}

/**
 * The engine's first `Error:` line without its label, paths removed and the
 * trailing punctuation trimmed, or undefined when there is none. Only a line
 * the engine marked as its error: progress and stdout chatter stay off.
 */
export function engineErrorReason(stderr: string, workDir?: string): string | undefined {
  const line = firstErrorLine(stderr);
  if (line === undefined) return undefined;
  const reason = withoutPaths(line.replace(/^Error:\s*/u, "").trim(), workDir).replace(/[.:\s]+$/u, "");
  return reason === "" ? undefined : reason;
}

/** The step every unclassified edit failure ends with (#88). */
export const UNCLASSIFIED_EDIT_STEP = "Fix or remove the pending edit it names, then apply again.";

/**
 * The step for an unclassified line that names a file rather than an edit
 * target (`failed to read <path> at byte 3`): no pending edit is at fault, so
 * the step points at the document and its assets (#93).
 */
export const UNCLASSIFIED_FILE_STEP =
  "Check that the document and any uploaded image can be read, reopen the document, then apply again.";

/**
 * The fixed heads of the engine's document and IO failures on the edit path,
 * as agent-hwp v1.6.2 writes them (Korean under every locale):
 * - hwpx/src/error.rs and hwp5/src/error.rs: `입출력 오류:`, `HWPX 파일이
 *   아닙니다 (`, `XML 파싱 오류 (`, `HWP 5.0 파일이 아닙니다 (`, `압축 해제
 *   실패 (`, `레코드 구조가 손상되었습니다:`, `엔트리가 없습니다:`, `HWPX 패키지
 *   무결성 오류:`, `FileHeader 시그니처가 올바르지 않습니다`, `FileHeader 크기가
 *   올바르지 않습니다 (`, `스트림이 없습니다:` (#142)
 * - hwp-convert/src/image.rs:369: `이미지 읽기 실패 `
 * - hwp-cli/src/edit_ops.rs:58: `편집 연산 입력을 읽을 수 없습니다:`
 * - hwp-cli commands/edit/form_bindings.rs:111: `staged_native_readback 실패:`
 * - hwp-cli commands/edit.rs:5534: `검증 재읽기 실패:`
 * - hwp-cli commands/cat.rs:193: `JSON IR 파싱 실패 (`
 */
export const FILE_LINE_HEAD =
  /^(?:입출력 오류: |HWPX 파일이 아닙니다 \(|XML 파싱 오류 \(|HWP 5\.0 파일이 아닙니다 \(|압축 해제 실패 \(|레코드 구조가 손상되었습니다: |엔트리가 없습니다: |HWPX 패키지 무결성 오류: |FileHeader 시그니처가 올바르지 않습니다|FileHeader 크기가 올바르지 않습니다 \(|스트림이 없습니다: |이미지 읽기 실패 |편집 연산 입력을 읽을 수 없습니다: |staged_native_readback 실패: |검증 재읽기 실패: |JSON IR 파싱 실패 \()/u;

/** A file head whose engine line already carries its own next step (#142). */
const OWN_STEP_HEAD = "staged_native_readback 실패: ";

/**
 * An edit failure no classifier recognised, as both transports print it: the
 * engine's own first `Error:` line with paths removed, then the step. A line
 * that opens with one of the engine's fixed IO heads (FILE_LINE_HEAD) names a
 * file it could not read or write, so it gets the file step; any other names
 * an edit target. Only the head at the start of the line counts, never a path
 * inside it, because an anchor the user typed can look like a path. With no
 * `Error:` line it is NO_ENGINE_CAUSE. Display text only; nothing classifies
 * from it. The full stderr stays on the error for a log.
 *
 * The head list is a display heuristic only; machine-readable refusal codes
 * (STAIxBWLB/agent-hwp#531) replace it.
 */
export function unclassifiedEditLine(stderr: string, workDir?: string): string {
  const reason = engineErrorReason(stderr, workDir);
  if (reason === undefined) return NO_ENGINE_CAUSE;
  // This head already ends in the engine's own Korean next step (form_bindings.rs:111).
  if (reason.startsWith(OWN_STEP_HEAD)) return `${reason}.`;
  const namesFile = FILE_LINE_HEAD.test(reason);
  return `${reason}. ${namesFile ? UNCLASSIFIED_FILE_STEP : UNCLASSIFIED_EDIT_STEP}`;
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
