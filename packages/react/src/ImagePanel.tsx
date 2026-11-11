import { isPlainDecimal } from "./unit-input.js";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, JSX } from "react";
import { imageAssetMediaType, MAX_IMAGE_ASSET_BYTES } from "@hwp-editor/core";
import { ErrorLine } from "./ErrorLine.js";
import { toEditorError } from "./errors.js";
import { useHwpEditorContext } from "./context.js";

type ChosenImage = { name: string; data: Uint8Array; extension: "png" | "jpg" };

export function ImagePanel(): JSX.Element {
  const { state, store, envelope, capabilities, editable, queueImage, onError, t } = useHwpEditorContext();
  const [anchor, setAnchor] = useState("");
  const [deleteAnchor, setDeleteAnchor] = useState("");
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [chosen, setChosen] = useState<ChosenImage | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<ReturnType<typeof toEditorError> | null>(null);
  const generation = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = capabilities?.imageAssets === "v1" && queueImage !== undefined;
  const disabled = !editable || state.document === null || envelope === null || state.status === "applying";
  const w = Number(width), h = Number(height);
  const naturalSize = width.trim() === "" && height.trim() === "";
  const validSize = naturalSize || (isPlainDecimal(width) && w > 0 && isPlainDecimal(height) && h > 0);

  useEffect(() => {
    generation.current += 1;
    if (fileInput.current !== null) fileInput.current.value = "";
    setChosen(null); setReading(false); setError(null); setAnchor(""); setDeleteAnchor("");
    return () => { generation.current += 1; };
  }, [state.document]);

  const choose = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const version = ++generation.current, source = store.getState().document;
    const file = event.target.files?.[0];
    setChosen(null); setError(null);
    if (file === undefined) return;
    setReading(true);
    try {
      if (file.size === 0 || file.size > MAX_IMAGE_ASSET_BYTES) throw new Error(t("image.invalidSize"));
      let bytes: ArrayBuffer;
      try { bytes = await file.arrayBuffer(); } catch { throw new Error(t("image.readError")); }
      const data = new Uint8Array(bytes), mediaType = imageAssetMediaType(data);
      if (mediaType === null) throw new Error(t("image.invalidType"));
      if (generation.current === version && store.getState().document === source) {
        setChosen({ name: file.name, data, extension: mediaType === "image/png" ? "png" : "jpg" });
      }
    } catch (failure) {
      if (generation.current === version && store.getState().document === source) { setError(toEditorError(failure)); onError?.(failure); }
    } finally { if (generation.current === version) setReading(false); }
  };
  const insert = (): void => {
    if (disabled || !uploading || chosen === null || !anchor.trim() || !validSize || queueImage === undefined) return;
    try {
      // This is a request correlation key, not a credential or filesystem path.
      const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const name = `image-${id}.${chosen.extension}`;
      queueImage({ kind: "insert-image", anchor: anchor.trim(), path: name, ...(naturalSize ? {} : { width: w, height: h }) }, { name, data: chosen.data });
      setError(null);
    } catch (failure) { setError(toEditorError(failure)); onError?.(failure); }
  };
  return (
    <div className="hwped-panel" role="region" aria-label={t("image.panelAria")} aria-busy={reading || state.status === "applying"}>
      <h3>{t("image.insert")}</h3>
      {!uploading && <p className="hwped-hint">{t("image.unsupported")}</p>}
      <label className="hwped-label" htmlFor="hwped-image-file">{t("image.file")}</label>
      <input ref={fileInput} id="hwped-image-file" type="file" accept="image/png,image/jpeg" disabled={disabled || !uploading || reading} onChange={event => void choose(event)} />
      <p className="hwped-hint">{reading ? t("image.reading") : chosen?.name ?? t("image.fileHint")}</p>
      <label className="hwped-label" htmlFor="hwped-image-anchor">{t("image.anchor")}</label>
      <input id="hwped-image-anchor" className="hwped-input" value={anchor} disabled={disabled || !uploading} onChange={event => setAnchor(event.target.value)} />
      <div className="hwped-row">
        <label>{t("image.width")}<input className="hwped-input" type="text" inputMode="decimal" value={width} disabled={disabled || !uploading} onChange={event => setWidth(event.target.value)} /></label>
        <label>{t("image.height")}<input className="hwped-input" type="text" inputMode="decimal" value={height} disabled={disabled || !uploading} onChange={event => setHeight(event.target.value)} /></label>
      </div>
      <p className="hwped-hint">{t("image.dimensionsHint")}</p>
      {!validSize && <p role="alert" className="hwped-hint">{t("image.invalidDimensions")}</p>}
      <button type="button" className="hwped-btn" disabled={disabled || !uploading || reading || chosen === null || !anchor.trim() || !validSize} onClick={insert}>{t("image.insert")}</button>
      <h3>{t("image.delete")}</h3>
      <label className="hwped-label" htmlFor="hwped-image-delete-anchor">{t("image.deleteAnchor")}</label>
      <p id="hwped-image-delete-hint" className="hwped-hint">{t("image.deleteAllHint")}</p>
      <input aria-describedby="hwped-image-delete-hint" id="hwped-image-delete-anchor" className="hwped-input" value={deleteAnchor} disabled={disabled} onChange={event => setDeleteAnchor(event.target.value)} />
      <button type="button" className="hwped-btn" disabled={disabled || !deleteAnchor.trim()} onClick={() => store.dispatch({ type: "queueOp", op: { kind: "delete-image", anchor: deleteAnchor.trim() } })}>{t("image.delete")}</button>
      {error !== null && <ErrorLine prefix={t("error.prefix.image")} {...error} />}
    </div>
  );
}
