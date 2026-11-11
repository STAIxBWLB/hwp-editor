import type {
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
  const at = address.at;
  const run = at !== undefined && "run" in at ? at.run : undefined;
  const base =
    at === undefined
      ? address.id !== undefined
        ? t("pending.target.id", { id: address.id })
        : t("pending.target.document")
      : run === undefined
        ? t("pending.target.at", { section: at.section, paragraph: at.paragraph })
        : t("pending.target.run", { section: at.section, paragraph: at.paragraph, run });
  const chars = "chars" in address ? address.chars : undefined;
  return chars === undefined
    ? base
    : t("pending.target.chars", { range: base, start: chars[0], end: chars[1] });
}

/**
 * The target half of a pending row.
 *
 * An addressed op shows its address; the flag-shaped ops show the value that
 * says which target they name (the text to find, an anchor, a field name). No
 * branch is a `JSON.stringify`: a row is read by a person deciding what to
 * remove from the queue, and `{"at":{"section":0,"paragraph":3}}` is not that.
 */
export function pendingTargetLabel(
  op: EditOp,
  t: TFunction,
  resolvers: PendingTargetResolvers = {},
): string {
  if ("address" in op) return pendingAddressLabel(op.address, t);
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
