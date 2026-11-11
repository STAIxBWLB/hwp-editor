import type {
  CatEnvelope,
  EditAddress,
  EditOp,
  MetaKey,
  PageSetupKey,
  ParagraphAddress,
  StyleTablePreset,
} from "@hwp-editor/core";
import type { MessageKey, TFunction } from "./messages.js";

/**
 * Operation name per `EditOp` kind for the pending list.
 *
 * A typed total `Record` rather than a template-literal cast: a new op kind
 * must fail `tsc --noEmit` here and force a naming decision, which a cast
 * would hide and the list would then print as a raw `find-table-row`.
 */
export const PENDING_KIND_KEYS: Record<EditOp["kind"], MessageKey> = {
  "add-col": "pending.kind.add-col",
  "add-row": "pending.kind.add-row",
  "add-table": "pending.kind.add-table",
  "apply-style": "pending.kind.apply-style",
  "clone-table": "pending.kind.clone-table",
  "create-bookmark": "pending.kind.create-bookmark",
  "create-field": "pending.kind.create-field",
  "create-hyperlink": "pending.kind.create-hyperlink",
  "create-style": "pending.kind.create-style",
  "delete-bookmark": "pending.kind.delete-bookmark",
  "delete-col": "pending.kind.delete-col",
  "delete-field": "pending.kind.delete-field",
  "delete-image": "pending.kind.delete-image",
  "delete-para": "pending.kind.delete-para",
  "delete-row": "pending.kind.delete-row",
  "delete-table": "pending.kind.delete-table",
  "indent-para": "pending.kind.indent-para",
  "insert-blocks": "pending.kind.insert-blocks",
  "insert-image": "pending.kind.insert-image",
  "insert-para": "pending.kind.insert-para",
  "insert-para-before": "pending.kind.insert-para-before",
  "merge-cells": "pending.kind.merge-cells",
  "move-para": "pending.kind.move-para",
  "outdent-para": "pending.kind.outdent-para",
  replace: "pending.kind.replace",
  seal: "pending.kind.seal",
  "set-align": "pending.kind.set-align",
  "set-cell": "pending.kind.set-cell",
  "set-field": "pending.kind.set-field",
  "set-format": "pending.kind.set-format",
  "set-meta": "pending.kind.set-meta",
  "set-page": "pending.kind.set-page",
  "set-para": "pending.kind.set-para",
  "split-cell": "pending.kind.split-cell",
  "style-tables": "pending.kind.style-tables",
  "update-style": "pending.kind.update-style",
};

/** Reuses the document panel's own labels rather than a second copy. */
const META_LABEL: Record<MetaKey, MessageKey> = {
  title: "document.metaTitle",
  author: "document.metaAuthor",
  subject: "document.metaSubject",
  keywords: "document.metaKeywords",
};

/** Reuses the page-setup panel's own labels rather than a second copy. */
const PAGE_LABEL: Record<PageSetupKey, MessageKey> = {
  width: "document.page.width",
  height: "document.page.height",
  "margin-left": "document.page.marginLeft",
  "margin-right": "document.page.marginRight",
  "margin-top": "document.page.marginTop",
  "margin-bottom": "document.page.marginBottom",
  orientation: "document.page.orientation",
};

export interface PendingTargetResolvers {
  /** A style reference: a row's name for a style this document defines. */
  style?: (ref: string | number) => string;
  /** A style-table preset's label. */
  preset?: (preset: StyleTablePreset) => string;
}

/** The operation name of a pending op. */
export function pendingKindKey(kind: EditOp["kind"]): MessageKey {
  return PENDING_KIND_KEYS[kind];
}

/**
 * One address, in the engine's own numbering.
 *
 * The indices are the ones the op carries and the engine reports refusals
 * against, not a renumbered display: a reader matching a queued row to an
 * engine message needs the same numbers on both sides.
 */
export function pendingAddressLabel(
  address: ParagraphAddress | EditAddress,
  t: TFunction,
): string {
  // A range op addresses a paragraph or a run by id and carries its WCHAR
  // window separately, so the window closes over whichever address it is.
  const chars = "chars" in address ? address.chars : undefined;
  const withChars = (base: string): string =>
    chars === undefined
      ? base
      : t("pending.target.chars", { range: base, start: chars[0], end: chars[1] });

  const at = address.at;
  if (at === undefined) {
    return withChars(
      address.id === undefined
        ? t("pending.target.document")
        : t("pending.target.id", { id: address.id }),
    );
  }
  if ("run" in at) {
    return withChars(
      t("pending.target.run", { section: at.section, paragraph: at.paragraph, run: at.run }),
    );
  }
  return withChars(t("pending.target.at", { section: at.section, paragraph: at.paragraph }));
}

/**
 * Whether a `set-format` window covers one piece of a split run in full.
 *
 * An op that names only the id of a split run formats every piece of it, so the
 * editor names the piece's own source span instead - and that window is the
 * piece, whole. The op shape therefore says nothing: a window that maps
 * character for character and a window that was widened to the piece look
 * alike, and only the document tells them apart.
 *
 * A run is a piece only when the document publishes a sibling under the same
 * id: an unsplit run has no pieces, so a window equal to its own span is that
 * run's window and says nothing about widening.
 */
function formatsWholePiece(
  envelope: CatEnvelope | null,
  id: string,
  chars: [number, number],
): boolean {
  if (envelope === null) return false;
  const pieces = envelope.segments.filter((segment) => segment.kind === "run" && segment.id === id);
  if (pieces.length < 2) return false;
  return pieces.some((segment) => segment.sourceChars !== undefined &&
    segment.sourceChars.start === chars[0] && segment.sourceChars.end === chars[1]);
}

/**
 * The target half of a pending row.
 *
 * An addressed op shows its address; the flag-shaped ops show the value that
 * says which target they name (the text to find, an anchor, a field name). No
 * branch is a `JSON.stringify`: a row is read by a person deciding what to
 * remove from the queue, and `{"at":{"section":0,"paragraph":3}}` is not that.
 *
 * `envelope` is what tells a whole-piece window from a mapped one, so a caller
 * that has the document should pass it; without it a window is shown as a
 * window.
 */
export function pendingTargetLabel(
  op: EditOp,
  t: TFunction,
  resolvers: PendingTargetResolvers = {},
  envelope: CatEnvelope | null = null,
): string {
  if ("address" in op) {
    // A `set-format` op that carries an id and no source window formats that
    // whole run, so the row says so: "element <id>" reads like a paragraph
    // target, and a reader deciding what to drop from the queue has to know
    // that characters outside their selection go with it.
    if (op.kind === "set-format" && op.address.id !== undefined) {
      if (op.address.chars === undefined) return t("pending.target.wholeRun", { id: op.address.id });
      if (formatsWholePiece(envelope, op.address.id, op.address.chars)) {
        return t("pending.target.wholePiece", { id: op.address.id });
      }
    }
    return pendingAddressLabel(op.address, t);
  }
  // A style reference is an id (number) or a name this batch creates (string);
  // the row is resolved back to a name the document shows.
  const style = (op as Record<string, unknown>).style;
  if (typeof style === "string" || typeof style === "number") {
    return resolvers.style === undefined ? String(style) : resolvers.style(style);
  }
  if (op.kind === "style-tables") {
    return resolvers.preset === undefined ? op.preset : resolvers.preset(op.preset);
  }
  if (op.kind === "set-meta") return t(META_LABEL[op.key]);
  if (op.kind === "set-page") return t(PAGE_LABEL[op.key]);
  // The flag-shaped ops name their target with one content field. Read by
  // property, not by `in`: TS widens a member that lacks the property to
  // `Record<prop, unknown>`, which is how `op.text` came back `unknown`.
  for (const prop of ["find", "anchor", "name", "text", "path"] as const) {
    const value = (op as Record<string, unknown>)[prop];
    if (typeof value === "string") return value;
  }
  const table = (op as Record<string, unknown>).table;
  if (typeof table === "number") return t("table.tableLabel", { index: table });
  const target = (op as Record<string, unknown>).target;
  if (typeof target === "number") return t("table.tableLabel", { index: target });
  if (typeof target === "string") return target;
  return t("pending.target.document");
}
