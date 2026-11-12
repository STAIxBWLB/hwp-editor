import { parsePageLayout } from "./layout.js";
import { classifyEditRefusal, editRefusalMarker, isEditRefusalKind } from "./refusals.js";
import { classifyInsertionRefusal, insertionRefusalLine, isInsertionRefusal, STOPPED_WITHOUT_DIAGNOSTIC, unclassifiedEditLine } from "./insertion-refusals.js";
import type { InsertionRefusal } from "./insertion-refusals.js";
import type { EditRefusalKind } from "./refusals.js";
/**
 * HwpEngine client for Tauri hosts (e.g. maru). Calls Rust commands named
 * `hwped_read / hwped_render / hwped_edit / hwped_compose / hwped_validate /
 * hwped_capabilities`, optionally `hwped_styles`; payloads mirror the
 * protocol.ts wire shapes, with two Tauri-specific deltas:
 *
 *   - File transfer: a document that already lives in the workspace crosses
 *     the bridge as a path string (`pathOf`); only in-memory bytes are sent,
 *     as base64 (`dataBase64`). Rust resolves relative paths against
 *     `workspaceRoot`.
 *   - Edit: a host advertising editOps v1 receives the edit-ops-v1 JSON
 *     array as `ops`; older hosts receive `opsArgv`. Exactly one is sent,
 *     and an edit failure never retries through the other channel.
 *
 * Zero dependencies: `invoke` is injected (peer pattern) — pass the real
 * `@tauri-apps/api/core` invoke in the host. Response shapes are the same
 * JSON the HTTP routes return (protocol.ts), so host code can swap
 * createHttpEngine <-> createTauriEngine without touching the editor.
 */

import type {
  Capabilities,
  ComposeResult,
  DocumentHandle,
  EditOptions,
  HwpEngine,
  PageImage,
  RenderOptions,
  ValidationReport,
} from "./engine.js";
import type { EditOp } from "./ops.js";
import { opsToArgv, opsToJson } from "./ops.js";
import type { CatEnvelope } from "./segments.js";
import { validateProjectedMetadata } from "./segments.js";
import { parseStyleTableResponse } from "./styles.js";
import { carriesPresetSwitch, presetBatchOptions, readPresetBatch } from "./style-batch.js";
import type { DocumentSpecV2 } from "./generated/document-spec-v2.js";
import type { TemplateDataV1, TemplateSpecV1 } from "./spec.js";
import type { LintProfile } from "./templates.js";
import { parseEmbeddedTemplates, parseFillReport, parseLintReport, parseTemplateInputs, parseTemplateMethods, parseTemplateReport, reportObject, reportString } from "./templates.js";
import { parseEditReport, withCallerName } from "./edit-report.js";
import type { EditReport } from "./edit-report.js";
import type {
  ComposeResponse,
  EditResponse,
  RenderResponse,
} from "./protocol.js";
import { base64, decodeTemplateDocument } from "./http-engine.js";
import {
  HwpEngineError,
  protectedReasonFromDiagnostics,
  toHwpErrorCode,
} from "./errors.js";
import type { HwpErrorCode } from "./errors.js";

/** Signature of `@tauri-apps/api/core`'s invoke, declared here so core stays
 *  dependency-free (peer pattern: the host injects the real one). */
export type TauriInvoke = <T>(
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/**
 * How a document crosses the Tauri bridge: a workspace path when the bytes
 * are already on disk (preferred), base64 bytes otherwise.
 */
export interface TauriDocumentRef {
  /** File name, including the .hwp/.hwpx extension. */
  name: string;
  /** Workspace-relative (or absolute) path to the document on disk. */
  path?: string;
  /** Base64-encoded bytes — only when the document is not on disk. */
  dataBase64?: string;
}

export interface TauriEngineOptions {
  /**
   * Workspace root the Rust side resolves relative `path`s against. Passed
   * through on every call as `workspaceRoot`.
   */
  workspaceRoot?: string;
  /**
   * Return a workspace-relative (or absolute) path for a document that
   * already lives on disk. When it returns undefined the document bytes are
   * sent as base64 instead.
   */
  pathOf?: (document: DocumentHandle) => string | undefined;
}

/**
 * maru's rejection prefixes, verified against
 * dev/maru/src-tauri/src/hwped.rs. Kept module-private here rather than in
 * errors.ts on purpose: these strings are maru's vocabulary, and a shared
 * home would imply every transport speaks them.
 *
 * No entry is a prefix of another, so match order is NOT load-bearing —
 * do not reorder this into a bug on the assumption that it is.
 */
const PREFIX_CODES: readonly (readonly [string, HwpErrorCode])[] = [
  ["cli_missing:", "unavailable"],
  ["hwp_spawn_failed:", "unavailable"],
  ["hwp_timeout:", "timeout"],
  ["hwp_aborted:", "failed"],
  ["hwp_failed:", "failed"],
  ["hwp_version:", "version"],
  ["hwped_bad_request:", "bad_request"],
  ["hwped_task_failed:", "failed"],
  ["hwp_stage_failed:", "internal"],
  ["hwp_parse_failed:", "failed"],
];

const TEMPLATE_COMMANDS = new Set([
  "hwped_slots", "hwped_fill", "hwped_template", "hwped_lint",
  "hwped_list_templates", "hwped_create",
]);

/**
 * The same unknown-command rescue for the styles family, whose remedy names
 * its own command rather than the template contract.
 */
const STYLE_COMMANDS = new Set(["hwped_styles"]);

function isUnknownCommand(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /(?:unknown|unregistered|not found|no such)\s+(?:tauri\s+)?command|command\s+[^\s]+\s+(?:not found|does not exist)/i.test(detail);
}

function prefixToCode(detail: string): HwpErrorCode {
  for (const [prefix, code] of PREFIX_CODES) {
    if (detail.startsWith(prefix)) return code;
  }
  // Conservative default: this package does not own maru's vocabulary, so
  // an unrecognized rejection (including "") is a generic engine failure
  // rather than a guessed specific one.
  return "failed";
}

/**
 * Read a stable HwpErrorCode out of whatever maru rejected with, so the
 * Tauri transport feeds the same badge table the HTTP transport does.
 *
 * No `status` is set: there is no HTTP status on this bridge, and
 * synthesizing one would invent information.
 */
function toEngineError(cmd: string, error: unknown, insertion = false): HwpEngineError {
  // Forward compatibility (Phase 7 / EXT-04): every hwped_* command is
  // `-> Result<T, String>` today, so this branch is dead now and goes live
  // for free when the Rust side moves to a structured Err.
  if (typeof error === "object" && error !== null && !(error instanceof Error)) {
    const rec = error as {
      code?: unknown;
      message?: unknown;
      refusal?: unknown;
      insertion?: unknown;
      stopped?: unknown;
    };
    if (typeof rec.code === "string") {
      const detail =
        typeof rec.message === "string" ? rec.message : String(error);
      return new HwpEngineError(
        // Narrowed, never cast: a future (or compromised) command handler
        // cannot inject a value outside the union into a typed field.
        toHwpErrorCode(rec.code),
        `${cmd} failed: ${detail}`,
        {
          cause: error,
          // The same fields the HTTP body carries, narrowed the same way (#88),
          // and the marker read the way the HTTP client reads it too: only
          // `true` counts (#91).
          ...(isEditRefusalKind(rec.refusal) ? { refusal: rec.refusal } : {}),
          ...(isInsertionRefusal(rec.insertion) ? { insertion: rec.insertion } : {}),
          ...(rec.stopped === true ? { stopped: true as const } : {}),
        },
      );
    }
  }
  const detail = error instanceof Error ? error.message : String(error);
  const code = prefixToCode(detail);
  const protectedReason = protectedReasonFor(cmd, code, detail);
  if (protectedReason !== null) {
    return new HwpEngineError("protected", `${cmd} failed: ${protectedReason}`, {
      cause: error,
    });
  }
  const edit = editFailure(cmd, code, detail, insertion);
  if (edit !== null) {
    return new HwpEngineError(code, `${cmd} failed: ${edit.message}`, { cause: error, ...edit.fields });
  }
  return new HwpEngineError(code, `${cmd} failed: ${detail}`, {
    cause: error,
  });
}

/**
 * maru's edit failure: `hwp_failed: hwp edit failed (exit N): <raw stderr>`
 * (dev/maru/src-tauri/src/hwped.rs run_hwp_ok). The head names the exit; the
 * rest is hwp-cli's stderr verbatim.
 */
const MARU_EDIT_FAILURE = /^hwp_failed: (hwp edit failed \(exit -?\d+\)): ([\s\S]*)$/u;

/**
 * An edit failure as the HTTP transport words the same stderr (#88), so the
 * two transports cannot drift:
 * - a classified refusal: the exit line plus its marker, and `refusal`;
 * - empty stderr: the exit line plus STOPPED_WITHOUT_DIAGNOSTIC, and `stopped`
 *   so a client shows that sentence in its own locale (#91);
 * - a batch carrying an insertion: the exit line plus the insert_blocks
 *   cause line, and `insertion` when the class is known;
 * - anything else: the engine's first Error: line with paths removed, then
 *   the step (`unclassifiedEditLine`).
 * The raw rejection stays on the error's `cause` for a log.
 */
function editFailure(
  cmd: string,
  code: HwpErrorCode,
  detail: string,
  insertion: boolean,
): { message: string; fields: { refusal?: EditRefusalKind; insertion?: InsertionRefusal; stopped?: true } } | null {
  if (code !== "failed" || cmd !== "hwped_edit") return null;
  const failure = MARU_EDIT_FAILURE.exec(detail);
  if (failure === null) return null;
  const head = failure[1]!;
  const stderr = failure[2]!;
  const kind = classifyEditRefusal(stderr);
  if (kind !== undefined) return { message: `${head}: ${editRefusalMarker(kind)}`, fields: { refusal: kind } };
  if (stderr.trim() === "") return { message: `${head}: ${STOPPED_WITHOUT_DIAGNOSTIC}`, fields: { stopped: true } };
  if (insertion) {
    const cls = classifyInsertionRefusal(stderr);
    return {
      message: `${head}: ${insertionRefusalLine(stderr)}`,
      fields: cls === undefined ? {} : { insertion: cls },
    };
  }
  // The engine's own first Error: line, paths removed, then the step: the
  // same display line HTTP prints. Nothing classifies from it.
  return { message: `${head}: ${unclassifiedEditLine(stderr)}`, fields: {} };
}

/**
 * Commands whose refusal may mean "this document is protected". Mirrors the
 * server's D-11 rule: `read` and `render` keep succeeding on protected
 * documents hwp-cli can still open, so a failure there is a real failure and
 * relabelling it would send the user to the wrong remedy.
 */
const PROTECTABLE_COMMANDS: ReadonlySet<string> = new Set([
  "hwped_edit",
  "hwped_compose",
]);

/**
 * The protection backstop for this transport.
 *
 * maru rejects with `Result<T, String>`, and its vocabulary
 * (dev/maru/src-tauri/src/hwped.rs) has no protected-specific prefix: a
 * refusal on a 배포용 document arrives under `hwp_failed:` carrying hwp-cli's
 * own Korean diagnostics, which `prefixToCode` can only read as `failed`.
 *
 * That has to be repaired HERE and not downstream. `engineErrorKind`
 * (packages/react/src/errors.ts) returns as soon as it recognises a code and
 * never reads the prose, which is the whole point of the Phase 2 contract:
 * the transport that owns the hwp-cli coupling is the one that must resolve
 * it, exactly as ERR-03 has the CLI server do in `rethrowProtected`. The
 * Tauri bridge is that boundary on this transport.
 *
 * Only `failed` is upgraded. A `timeout` or `unavailable` whose text happens
 * to carry one of the engine's protection lines is still a timeout or an
 * unavailable engine.
 */
function protectedReasonFor(
  cmd: string,
  code: HwpErrorCode,
  detail: string,
): string | null {
  if (code !== "failed" || !PROTECTABLE_COMMANDS.has(cmd)) return null;
  return protectedReasonFromDiagnostics(detail);
}

export function createTauriEngine(
  invoke: TauriInvoke,
  opts: TauriEngineOptions = {},
): HwpEngine {
  function ref(document: DocumentHandle): TauriDocumentRef {
    const path = opts.pathOf?.(document);
    if (path !== undefined) return { name: document.name, path };
    return { name: document.name, dataBase64: base64.encode(document.data) };
  }

  function scope(): Record<string, unknown> {
    return opts.workspaceRoot !== undefined
      ? { workspaceRoot: opts.workspaceRoot }
      : {};
  }

  async function call<T>(cmd: string, args: Record<string, unknown>, insertion = false): Promise<T> {
    try {
      return await invoke<T>(cmd, args);
    } catch (error) {
      if (TEMPLATE_COMMANDS.has(cmd) && isUnknownCommand(error)) {
        throw new HwpEngineError(
          "unavailable",
          `${cmd} is unsupported by this host; upgrade the host to the hwp-cli 1.4.0 template contract and retry.`,
          { cause: error },
        );
      }
      if (STYLE_COMMANDS.has(cmd) && isUnknownCommand(error)) {
        throw new HwpEngineError(
          "unavailable",
          `${cmd} is unsupported by this host; upgrade the host to the hwp-cli 1.4.0 styles command and retry.`,
          { cause: error },
        );
      }
      throw toEngineError(cmd, error, insertion);
    }
  }

  async function capabilities(): Promise<Capabilities> {
    const raw = reportObject(await call<unknown>("hwped_capabilities", {}), "capabilities");
    const methods = raw.templateMethods === undefined ? [] : parseTemplateMethods(raw.templateMethods);
    const { editOps, styles, ...rest } = raw as unknown as Capabilities;
    // This client has no image-byte Tauri command, even if a host claims one.
    delete rest.imageAssets;
    return {
      ...rest,
      templateMethods: methods,
      ...(editOps === "v1" ? { editOps: "v1" as const } : {}),
      ...(styles === "v1" ? { styles: "v1" as const } : {}),
    };
  }

  return {
    async slots(document) {
      return parseTemplateInputs(await call<unknown>("hwped_slots", { document: ref(document), ...scope() }));
    },

    async fill(document, values) {
      const raw = reportObject(await call<unknown>("hwped_fill", { document: ref(document), values, ...scope() }), "fill.response");
      return { document: decodeTemplateDocument(raw, "fill.document"), report: parseFillReport(raw.report) };
    },

    async template(spec: TemplateSpecV1, data: TemplateDataV1, name: string) {
      const raw = reportObject(await call<unknown>("hwped_template", { spec, data, name, ...scope() }), "template.response");
      const document = decodeTemplateDocument(raw, "template.document");
      return { document, ...(raw.report !== undefined ? { report: parseTemplateReport(raw.report) } : {}) };
    },

    async lint(document, profile?: LintProfile) {
      return parseLintReport(await call<unknown>("hwped_lint", { document: ref(document), ...(profile !== undefined ? { profile } : {}), ...scope() }));
    },

    async listTemplates() {
      return parseEmbeddedTemplates(await call<unknown>("hwped_list_templates", { ...scope() }));
    },

    async create(templateId, name) {
      return decodeTemplateDocument(await call<unknown>("hwped_create", { templateId, name, ...scope() }), "create.document");
    },

    read(document) {
      return call<CatEnvelope>("hwped_read", {
        document: ref(document),
        ...scope(),
      }).then(validateProjectedMetadata);
    },

    async styles(document) {
      return parseStyleTableResponse(
        await call<unknown>("hwped_styles", { document: ref(document), ...scope() }),
      );
    },

    async render(document, options: RenderOptions = {}) {
      const res = await call<RenderResponse>("hwped_render", {
        document: ref(document),
        options,
        ...scope(),
      });
      return res.pages.map(
        (p): PageImage => ({
          page: p.page,
          width: p.width,
          height: p.height,
          dpi: p.dpi,
          format: p.format,
          ...(p.layout === undefined ? {} : { layout: parsePageLayout(p.layout) }),
          data: base64.decode(p.dataBase64),
        }),
      );
    },

    async edit(document, ops: EditOp[], options: EditOptions = {}) {
      if (options.assets !== undefined && options.assets.length > 0) {
        // Only the bytes are refused: the JSON op channel carries an
        // insert-image path and the sidecar hands the ops to `hwp edit --ops`
        // unchanged, so an API caller does have a route (#113 item 4). The app
        // UI does not, which is why the word-processor step lives in
        // image.unsupported.
        throw new HwpEngineError("unavailable", "Image-byte uploads are unsupported by this Tauri client; an API caller can send an insert-image op with a local path instead, which the JSON op channel passes to `hwp edit --ops` unchanged while the legacy argv channel needs workspaceRoot containing the file, and a caller holding only bytes needs the HTTP client with an engine that advertises image-asset uploads (hwp-cli 1.4.0 or newer).");
      }
      const caps = await capabilities();
      const channel = caps.editOps === "v1"
        ? { ops: JSON.parse(opsToJson(ops)) as unknown[] }
        : { opsArgv: opsToArgv(ops) };
      // A `style-tables` op travels inside the ops array like every other op,
      // so nothing here needs a field of its own; its outcome arrives in the
      // report. A preset batch needs `allowPartial` and `report` both, and
      // the rule that says so is the same one the HTTP client obeys
      // (style-batch.ts): a desktop host that asked for the report alone
      // aborted the whole edit on a table-less document, which is t12-a2 on
      // this transport.
      const effective = presetBatchOptions(ops, options);
      const wantsReport = effective.report === true;
      const res = await call<EditResponse>("hwped_edit", {
        document: ref(document),
        ...channel,
        ...(options.verify !== undefined ? { verify: options.verify } : {}),
        ...(effective.allowPartial !== undefined
          ? { allowPartial: effective.allowPartial }
          : {}),
        ...(wantsReport ? { report: true } : {}),
        ...scope(),
      }, ops.some(op => op.kind === "insert-blocks"));
      let report: EditReport | undefined;
      if (wantsReport && res.report !== undefined) {
        try {
          report = parseEditReport(res.report);
        } catch {
          // A host that answers with an unreadable report is a host whose ids
          // are unknown, not a failed edit: the document itself was published.
          // A preset batch below reads that absence as a refusal, because for
          // it the report IS the outcome.
          report = undefined;
        }
      }
      if (carriesPresetSwitch(ops)) {
        const reading = readPresetBatch(report);
        if (reading.refusal !== null) {
          throw new HwpEngineError(reading.refusal.code, reading.refusal.message);
        }
      }
      // The host's report names the `-o` path it staged the document at, and a
      // caller has no business seeing it: the same rewrite the CLI server's
      // engine and its HTTP route apply.
      const named = report === undefined ? undefined : withCallerName(report, res.name);
      return { name: res.name, data: base64.decode(res.dataBase64), ...(named === undefined ? {} : { report: named }) };
    },

    async compose(spec: DocumentSpecV2, name: string): Promise<ComposeResult> {
      const res = await call<ComposeResponse>("hwped_compose", { spec, name });
      return {
        document: { name: res.name, data: base64.decode(res.dataBase64) },
        ...(res.report !== undefined ? { report: res.report } : {}),
      };
    },

    validate(document) {
      return call<ValidationReport>("hwped_validate", {
        document: ref(document),
        ...scope(),
      });
    },

    capabilities,
  };
}
