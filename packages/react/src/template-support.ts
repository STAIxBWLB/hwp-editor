import type { Capabilities, HwpEngine } from "@hwp-editor/core";
import { templateVersionSupported } from "@hwp-editor/core";
import type { TemplateMethod } from "@hwp-editor/core";
import { TEMPLATE_MIN_VERSION } from "@hwp-editor/core";
import type { MessageKey, TFunction } from "./messages.js";

const METHOD_LABEL_KEYS: Record<TemplateMethod, MessageKey> = {
  slots: "templates.methodSlots",
  fill: "templates.methodFill",
  template: "templates.methodTemplate",
  lint: "templates.methodLint",
  listTemplates: "templates.methodList",
  create: "templates.methodCreate",
};

export function templateMethodStatus(
  engine: HwpEngine,
  capabilities: Capabilities | null,
  method: TemplateMethod,
): { supported: boolean; reason: "version" | "missing" | "unadvertised" | null } {
  if (!templateVersionSupported(capabilities?.version ?? "")) {
    return { supported: false, reason: "version" };
  }
  if (typeof engine[method] !== "function") {
    return { supported: false, reason: "missing" };
  }
  if (capabilities?.templateMethods !== undefined && !capabilities.templateMethods.includes(method)) {
    return { supported: false, reason: "unadvertised" };
  }
  return { supported: true, reason: null };
}

export function templateStatusReason(
  t: TFunction,
  status: ReturnType<typeof templateMethodStatus>,
  method: TemplateMethod,
): string {
  if (status.reason === "version") return t("templates.versionRequired", { version: TEMPLATE_MIN_VERSION });
  const label = t(METHOD_LABEL_KEYS[method]);
  if (status.reason === "missing") return t("templates.methodMissing", { method: label });
  if (status.reason === "unadvertised") return t("templates.methodUnadvertised", { method: label });
  return "";
}
