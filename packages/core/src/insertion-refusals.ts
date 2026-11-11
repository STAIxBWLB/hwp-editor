/**
 * The `insert_blocks` refusal classes, shared by every transport (#88). The
 * HTTP server and the Tauri client both build the same one-line cause from
 * the engine's stderr and attach the class as a structured field, so the
 * editor picks its sentence from the field and never from message text,
 * which on an unclassified failure can carry what the user typed.
 *
 * The engine writes these diagnostics in Korean under every locale (`--lang`
 * localizes clap help only; measured on ahwp 1.6.0), so the markers are
 * Korean and permanent, like `PROTECTED_MARKERS`.
 *
 * The invalid-definition class is keyed on the engine's schema sentence, not
 * on the `insert_blocks` token: that token also appears in refusals that say
 * nothing about the component (before a section's definition paragraph, an
 * address that is not a body paragraph or a cell). Those carry no class and
 * keep the engine's own line, with paths replaced.
 */

/** The class of an `insert_blocks` refusal, with what the engine measured. */
export type InsertionRefusal =
  | { kind: "layout_overflow"; blockMm?: number; insertionMm?: number }
  | { kind: "unknown_style"; style: string }
  | { kind: "invalid_definition" };

const STYLE_LINE = /스타일 '(.*)'을 대상 문서에서 찾을 수 없습니다/u;
const INVALID_DEFINITION = "블록/스타일/목록 정의가 유효하지 않습니다";

function millimetres(stderr: string, pattern: RegExp): number | undefined {
  const raw = pattern.exec(stderr)?.[1];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * The class an `insert_blocks` refusal's stderr names, or undefined when it
 * is not one of the three. Read only from the engine's `Error:` line on, so a
 * value echoed before it cannot decide the class.
 */
export function classifyInsertionRefusal(stderr: string): InsertionRefusal | undefined {
  const at = stderr.search(/^Error: /mu);
  if (at < 0) return undefined;
  const text = stderr.slice(at);
  const style = STYLE_LINE.exec(text)?.[1];
  if (style !== undefined) return { kind: "unknown_style", style };
  if (!text.includes(INVALID_DEFINITION)) return undefined;
  if (!text.includes("layout_overflow")) return { kind: "invalid_definition" };
  // "column widths total 120.00 mm; body width is 46.40 mm" for a column
  // sum, "exceeds body width 46.40 mm" for the table's own width, and the
  // destination width again in the Korean tail.
  const blockMm = millimetres(text, /column widths total ([\d.]+) ?mm/u);
  const insertionMm = millimetres(text, /body width (?:is )?([\d.]+) ?mm/u) ??
    millimetres(text, /삽입 위치의 폭은 ([\d.]+)mm/u);
  return {
    kind: "layout_overflow",
    ...(blockMm === undefined ? {} : { blockMm }),
    ...(insertionMm === undefined ? {} : { insertionMm }),
  };
}

/** Narrow an untrusted value (a wire field, a host error) to an insertion class. */
export function isInsertionRefusal(value: unknown): value is InsertionRefusal {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  const optionalMm = (key: string): boolean =>
    rec[key] === undefined || (typeof rec[key] === "number" && Number.isFinite(rec[key]));
  switch (rec.kind) {
    case "layout_overflow":
      return optionalMm("blockMm") && optionalMm("insertionMm");
    case "unknown_style":
      return typeof rec.style === "string" && rec.style !== "";
    case "invalid_definition":
      return true;
    default:
      return false;
  }
}

/**
 * Text the engine wrote, with no path in it: the given work dir first, then
 * anything else that reads as an absolute path. The replacement fires only
 * where a path can start, so a Korean diagnostic's own `블록/스타일/목록`
 * slashes survive.
 */
export function withoutPaths(text: string, workDir?: string): string {
  const withoutWorkDir = workDir === undefined || workDir === "" ? text : text.split(workDir).join("<work dir>");
  return withoutWorkDir.replace(
    /(^|[\s"'(\[{])([A-Za-z]:[\\/][^\s"')\]}]*|\/[^\s"')\]}]*)/gu,
    "$1<path>",
  );
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
  const lines = stderr.split(/\r?\n/u).map(entry => entry.trim()).filter(entry => entry !== "");
  const line = lines.find(entry => /^error:/iu.test(entry)) ?? lines[0] ?? "";
  // That line opens with the op's own name; the prefix already names it.
  const reason = withoutPaths(line.replace(/^error:\s*/iu, "").replace(/^insert_blocks\s+/u, ""), workDir);
  return reason === "" ? "insert_blocks refused" : `insert_blocks refused: ${reason}`;
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
