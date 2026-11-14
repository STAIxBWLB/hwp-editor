/**
 * One classifier for the edit refusals the editor shows as their own
 * sentence, shared by every transport (#80): the HTTP server applies it to the
 * CLI's stderr, the Tauri client to the stderr maru forwards. A second copy is
 * how the transports drift (REVIEW.md "Transports stay in step").
 *
 * hwp-cli v1.6.1 publishes no machine code for these refusals; they are plain
 * anyhow strings. Each is matched on the fixed shape of its OWN line, never on
 * a token anywhere in stderr: the engine echoes user values (a replace's
 * from/to on progress lines, anchors, urls and names on the unapplied-list
 * line), and a value must never decide the classification. Most values are
 * written with Rust's `{:?}`, but some with Display (an anchor at
 * hwp-convert/src/edit.rs:2107, add_table; an insert_blocks style name at insert_blocks.rs:370 and :373),
 * so a value CAN carry a newline and forge a line of its own. The matchers
 * therefore read only the first `Error:` line, plus the conflict list's own
 * entries below its fixed head. hwp-cli v1.6.1 never wraps the range-tag or
 * drift refusal in a context chain (runtime.rs:324-331), so neither needs a
 * `Caused by:` line.
 *
 * The stderr functions below remain compatibility fallbacks when a host or
 * engine provides no structured refusal, regardless of engine version. A
 * valid report.refusal uses reportRefusalFields instead, including unclassified;
 * malformed present reports never re-enable these classifiers.
 *
 * Classification exposes fixed kinds and typed values, not diagnostic prose.
 * The engine's staged paths and
 * the user's values stay in the error's stderr/detail for an operator.
 */

import type { EditReport } from "./edit-report.js";
import type { InsertionRefusal } from "./insertion-refusals.js";

export type EditRefusalKind = "unmatched_replace" | "run_range_conflict" | "range_tag" | "unresolvable_address" | "output_validation" | "keep_together_unsupported" | "section_owner" | "anchor_not_found" | "font_type_info" | "preservation_loss" | "unapplied_requests" | "no_applicable_edits" | "unclassified_refusal";

const KINDS: ReadonlySet<string> = new Set<EditRefusalKind>(["unmatched_replace", "run_range_conflict", "range_tag", "unresolvable_address", "output_validation",
  "keep_together_unsupported", "section_owner", "anchor_not_found", "font_type_info",
  "preservation_loss", "unapplied_requests", "no_applicable_edits", "unclassified_refusal"]);

/** Narrow an untrusted value (a wire field, a host error) to a refusal kind. */
export function isEditRefusalKind(value: unknown): value is EditRefusalKind {
  return typeof value === "string" && KINDS.has(value);
}

/** The suffix a transport appends to an error message for a classified refusal. */
export function editRefusalMarker(kind: EditRefusalKind): string {
  return `edit refused: ${kind}`;
}

/** The engine's line for a request that matched nothing (commands/edit.rs:1117). */
const UNAPPLIED_EDIT_LINE = /^Error: 적용되지 않은 편집 요청이 있습니다: /u;
/** The engine closes that list with this hint; it is not part of any item. */
const UNAPPLIED_EDIT_SUFFIX = "(--allow-partial";
/** The batch preflight's conflict list head (commands/edit.rs:1131). */
const CONFLICT_HEAD = /^Error: 주소 지정 편집이 서로 충돌합니다:$/u;
/** `ConflictKind::LengthChange` (commands/edit.rs:1137): only op indices and a path. */
const LENGTH_CHANGE_LINE = /^op\[\d+\]이 문단 \S+의 길이를 바꿀 수 있어 op\[\d+\]의 고정된 run 범위가 무효화됩니다$/u;
/**
 * The apply-time content-drift bail (commands/edit.rs:3553-3563), whose only
 * interpolations are numbers, on the Error: line itself.
 */
const DRIFT_LINE = new RegExp(
  `^Error: set_format 주소 \\[\\d+, \\d+\\)의 문단은 앞선 연산\\([^)]*\\)으로 글자 수가 \\d+에서 (?:\\d+|알 수 없음)\\(으\\)로 바뀌어 범위가 다른 글자를 가리킵니다\\.`,
  "u",
);
/** `RANGE_TAG_SHIFT_REFUSAL` (hwp-convert/src/edit.rs:179), a fixed sentence. */
const RANGE_TAG_LINE = new RegExp(`^Error: 미해석 PARA_RANGE_TAG 구간 표시가 있어 WCHAR 위치가 바뀌거나`, "u");

/**
 * agent-hwp v1.6.2, crates/hwp-cli/src/commands/edit.rs:2269-2284,
 * :3086-3094, and crates/hwp-convert/src/address.rs:120, :226-261.
 * NoSuchPath also covers missing paths, so do not infer a nested target.
 * Each entry contains only an op index, an id/at address and the fixed cause.
 */
const ADDRESS_HEAD = /^Error: 주소를 해석할 수 없는 편집 연산이 있습니다:$/u;
const ADDRESS_PATH_LINE = /^op\[\d+\] (?:id [0-9a-f]{16}\.\d+(?:\.\d+)+|at \d+(?:\.\d+)+) — 주소가 가리키는 위치를 문서에서 찾을 수 없습니다$/u;

/**
 * ahwp 2.0.0's output verification wrapper, measured in FONT_TYPE_INFO.
 * The target path is opaque user data between this fixed head and tail.
 * The Caused-by/event list is never read: font metadata is only one possible
 * cause. Modern transports consume agent-hwp#531 codes through
 * reportRefusalFields (#119 item 1); this wrapper remains for no-report hosts.
 */
const OUTPUT_VALIDATION_LINE = /^Error: 출력 검증 실패 \(대상: .*\)$/u;

/** stderr from its first `Error:` line on, as lines; empty when there is none. */
function errorLines(stderr: string): string[] {
  const lines = stderr.split(/\r?\n/u);
  const at = lines.findIndex(line => line.startsWith("Error: "));
  return at < 0 ? [] : lines.slice(at);
}

/** Match every error-list entry, stopping before anyhow's optional backtrace. */
function errorListMatches(lines: string[], pattern: RegExp): boolean {
  const blank = lines.findIndex((line, at) => at > 0 && line.trim() === "");
  const entries = lines.slice(1, blank < 0 ? undefined : blank).filter(line => line.trim() !== "");
  return entries.length > 0 && entries.every(line => pattern.test(line));
}

/**
 * The ops the engine lists as unapplied on its Error: line, or undefined when
 * that line is not the list.
 *
 * Items follow the marker and are separated by `, `, each opening with its op
 * name: `replace address=0.0 from="NOPE" to="x", set_field name="f"`. Values
 * are `{:?}`-quoted, so the split respects double quotes and skips the
 * character an unescaped backslash escapes. The suffix is searched from the
 * end, because a value may carry the same text.
 */
function unappliedItems(line: string): string[] | undefined {
  const head = UNAPPLIED_EDIT_LINE.exec(line);
  if (head === null) return undefined;
  const tail = line.slice(head[0].length);
  const suffixAt = tail.lastIndexOf(UNAPPLIED_EDIT_SUFFIX);
  const body = (suffixAt < 0 ? tail : tail.slice(0, suffixAt)).trim();
  if (body === "") return undefined;
  const items: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const character of body) {
    if (escaped) {
      escaped = false;
      current += character;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      current += character;
      continue;
    }
    if (character === "\"") quoted = !quoted;
    if (character === "," && !quoted) {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  items.push(current.trim());
  return items.filter(item => item !== "");
}

/**
 * The refusal an edit's stderr carries, or undefined to keep the failure as
 * it is.
 *
 * - `unmatched_replace`: the unapplied list, when every listed op is a
 *   `replace`. Any other unapplied list stays unclassified, and its line is
 *   never searched for the other refusals: it echoes user values.
 * - `run_range_conflict`: the conflict list when EVERY entry is a
 *   LengthChange. A list that also holds a Removal stays unclassified, since
 *   the run-range next step would clear only part of it. Or the content-drift
 *   line.
 * - `range_tag`: the range-tag sentence on the Error: line.
 * - `unresolvable_address`: a resolver list containing only NoSuchPath entries.
 * - `output_validation`: the output verification wrapper, whatever its cause.
 */
export function classifyEditRefusal(stderr: string): EditRefusalKind | undefined {
  const lines = errorLines(stderr);
  const first = lines[0];
  if (first === undefined) return undefined;
  if (UNAPPLIED_EDIT_LINE.test(first)) {
    const items = unappliedItems(first);
    return items !== undefined && items.length > 0 && items.every(item => /^replace\s/u.test(item))
      ? "unmatched_replace"
      : undefined;
  }
  if (CONFLICT_HEAD.test(first)) {
    return errorListMatches(lines, LENGTH_CHANGE_LINE) ? "run_range_conflict" : undefined;
  }
  if (ADDRESS_HEAD.test(first)) {
    return errorListMatches(lines, ADDRESS_PATH_LINE) ? "unresolvable_address" : undefined;
  }
  if (OUTPUT_VALIDATION_LINE.test(first)) return "output_validation";
  if (RANGE_TAG_LINE.test(first)) return "range_tag";
  if (DRIFT_LINE.test(first)) return "run_range_conflict";
  return undefined;
}


/** Machine-code mapping shared by all transports; never reads diagnostic prose. */
export function reportRefusalFields(report: EditReport): { refusal?: EditRefusalKind; insertion?: InsertionRefusal } {
  const refusal = report.refusal;
  if (refusal === undefined) return {};
  switch (refusal.code) {
    case "range_tag_shift": return { refusal: "range_tag" };
    case "keep_together_unsupported": return { refusal: "keep_together_unsupported" };
    case "section_owner_insert": case "section_owner_move": return { refusal: "section_owner" };
    case "add_table.anchor_not_found": return { refusal: "anchor_not_found" };
    case "insert_blocks.unknown_style":
      return { insertion: { kind: "unknown_style", style: refusal.values.style } };
    case "insert_blocks.invalid_definition": case "insert_blocks.style_not_paragraph":
    case "insert_blocks.duplicate_style": case "insert_blocks.style_cycle":
    case "insert_blocks.style_id_overflow": case "insert_blocks.invalid_spec":
      return { insertion: { kind: "invalid_definition" } };
    case "layout_overflow": {
      const blockMm = refusal.values.issues.reduce<number | undefined>((widest, issue) =>
        issue.code !== "layout_overflow" || issue.measured_width_mm === undefined ? widest :
          Math.max(widest ?? 0, issue.measured_width_mm), undefined);
      const insertionMm = refusal.values.container_width_mm;
      return { insertion: { kind: "layout_overflow",
        ...(blockMm === undefined || blockMm <= 0 ? {} : { blockMm }),
        ...(insertionMm <= 0 ? {} : { insertionMm }),
      } };
    }
    case "preservation_loss":
      return { refusal: refusal.values.events.some(event => event.code === "font_type_info_unrepresentable")
        ? "font_type_info" : "preservation_loss" };
    case "unapplied_requests": {
      const failed = report.ops.filter(op => op.status === "failed");
      return { refusal: failed.length > 0 && failed.length === report.failed_count && failed.every(op => op.op === "replace")
        ? "unmatched_replace" : "unapplied_requests" };
    }
    case "no_applicable_edits": return { refusal: "no_applicable_edits" };
    case "unclassified": return { refusal: "unclassified_refusal" };
  }
}
