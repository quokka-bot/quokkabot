import { useCallback, useEffect, useRef, useState } from "react";
import { ImageMediaType, MAX_IMAGE_BYTES, MAX_MESSAGE_IMAGES, type Attachment } from "@quokkabot/shared";
import { api, attachmentContentUrl, errorMessage } from "./api.js";

const PREPARED_SIDE = 1568;
export const IMAGE_ACCEPT = ImageMediaType.options.join(",");

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("This image could not be read.")); };
    image.src = url;
  });
}
function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("This image could not be prepared.")), type, quality));
}
function renamed(name: string, type: string, originalType: string): string {
  if (type === originalType) return name;
  const extension = type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png";
  return `${name.replace(/\.[^.]+$/, "")}.${extension}`;
}
export async function prepareImage(file: File): Promise<File> {
  if (!ImageMediaType.safeParse(file.type).success) throw new Error("Choose a PNG, JPEG, GIF or WebP image.");
  if (file.type === "image/gif") {
    if (file.size > MAX_IMAGE_BYTES) throw new Error("GIFs must be at most 3.75 MB. Choose a smaller GIF.");
    return file;
  }
  const image = await loadImage(file);
  const longEdge = Math.max(image.naturalWidth, image.naturalHeight);
  if (longEdge < 1) throw new Error("This image has no pixel size.");
  if (longEdge <= PREPARED_SIDE && file.size <= MAX_IMAGE_BYTES) return file;
  const scale = Math.min(1, PREPARED_SIDE / longEdge);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare images.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  let blob: Blob = longEdge > PREPARED_SIDE ? await encode(canvas, file.type) : file;
  if (blob.size > MAX_IMAGE_BYTES) {
    // JPEG has no alpha channel. Keep transparent screenshots readable against white.
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    blob = await encode(canvas, "image/jpeg", 0.85);
  }
  if (blob.size > MAX_IMAGE_BYTES) throw new Error("This image is still over 3.75 MB. Choose a smaller image.");
  return new File([blob], renamed(file.name, blob.type, file.type), { type: blob.type });
}

type DraftImage = { key: string; name: string; url: string | null; status: "uploading" | "ready" | "failed"; error: string | null; attachment: Attachment | null };
export function useChatImages(agentId: string, disabled: boolean) {
  const [images, setImages] = useState<DraftImage[]>([]);
  const current = useRef<DraftImage[]>([]);
  const jobs = useRef(new Map<string, Promise<void>>());
  const alive = useRef(true);
  const update = useCallback((next: DraftImage[]) => { current.current = next; if (alive.current) setImages(next); }, []);
  const clear = useCallback(() => {
    for (const image of current.current) if (image.url) URL.revokeObjectURL(image.url);
    update([]);
  }, [update]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; for (const image of current.current) if (image.url) URL.revokeObjectURL(image.url); }; }, []);
  const add = useCallback((files: readonly File[]) => {
    if (disabled) return;
    // One removable error chip explains an oversized selection without creating hundreds of previews.
    for (const file of files.slice(0, Math.max(1, MAX_MESSAGE_IMAGES + 1 - current.current.length))) {
      const tooMany = current.current.length >= MAX_MESSAGE_IMAGES;
      const validType = ImageMediaType.safeParse(file.type).success;
      const image: DraftImage = { key: crypto.randomUUID(), name: file.name, url: validType && !tooMany ? URL.createObjectURL(file) : null,
        status: tooMany ? "failed" : "uploading", error: tooMany ? "Attach at most 8 images per message." : null, attachment: null };
      update([...current.current, image]);
      if (tooMany) continue;
      const job = (async () => {
        try {
          const prepared = await prepareImage(file);
          const attachment = await api.uploadImage(agentId, prepared);
          update(current.current.map(item => item.key === image.key ? { ...item, name: prepared.name, attachment, status: "ready" } : item));
        } catch (error) {
          update(current.current.map(item => item.key === image.key ? { ...item, status: "failed", error: errorMessage(error) } : item));
        }
      })();
      jobs.current.set(image.key, job);
      void job.finally(() => jobs.current.delete(image.key));
    }
  }, [agentId, disabled, update]);
  const remove = (key: string) => {
    const image = current.current.find(item => item.key === key);
    if (image?.url) URL.revokeObjectURL(image.url);
    update(current.current.filter(item => item.key !== key));
  };
  const uploadedIds = async () => {
    await Promise.all(current.current.map(image => jobs.current.get(image.key)));
    return current.current.map(image => {
      if (!image.attachment || image.status !== "ready") throw new Error(image.error ?? "Wait for the images to upload.");
      return image.attachment.id;
    });
  };
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files");
    const enter = (event: DragEvent) => { if (hasFiles(event)) { event.preventDefault(); depth++; if (!disabled) setDragging(true); } };
    const over = (event: DragEvent) => { if (hasFiles(event)) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = disabled ? "none" : "copy"; } };
    const leave = (event: DragEvent) => { if (hasFiles(event) && --depth <= 0) { depth = 0; setDragging(false); } };
    const drop = (event: DragEvent) => {
      // Cancel every file drop on this screen, including drops outside the composer.
      if (hasFiles(event) || event.dataTransfer?.files.length) { event.preventDefault(); depth = 0; setDragging(false); add(Array.from(event.dataTransfer?.files ?? [])); }
    };
    const end = () => { depth = 0; setDragging(false); };
    window.addEventListener("dragenter", enter); window.addEventListener("dragover", over); window.addEventListener("dragleave", leave); window.addEventListener("drop", drop); window.addEventListener("dragend", end);
    return () => { window.removeEventListener("dragenter", enter); window.removeEventListener("dragover", over); window.removeEventListener("dragleave", leave); window.removeEventListener("drop", drop); window.removeEventListener("dragend", end); };
  }, [add, disabled]);
  return { images, add, remove, clear, uploadedIds, dragging, failed: images.some(image => image.status === "failed") };
}

export function ImageChips({ draft, disabled }: { draft: ReturnType<typeof useChatImages>; disabled: boolean }) {
  return <div className="image-chips">{draft.images.map(image => <div className={`image-chip ${image.status}`} key={image.key} aria-label={`Attachment ${image.name}`}>
    {image.url && <img src={image.url} alt={image.name} />}
    <button type="button" className="image-remove" aria-label={`Remove ${image.name}`} disabled={disabled} onClick={() => draft.remove(image.key)}>×</button>
    {image.status === "uploading" && <span className="image-spinner" role="status" aria-label={`Uploading ${image.name}`} />}
    {image.error && <span className="image-error" role="alert">{image.error}</span>}
    <span className="image-name" title={image.name}>{image.name}</span>
  </div>)}</div>;
}

export function OwnerImages({ attachments }: { attachments: readonly Attachment[] }) {
  const [selected, setSelected] = useState<Attachment | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!selected) return;
    dialog.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setSelected(null); trigger.current?.focus(); }
      if (event.key === "Tab") { event.preventDefault(); dialog.current?.querySelector("button")?.focus(); }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selected]);
  if (attachments.length === 0) return null;
  const close = () => { setSelected(null); trigger.current?.focus(); };
  return <>
    <div className={`owner-images ${attachments.length === 1 ? "single" : "grid"}`}>{attachments.map(attachment =>
      <button type="button" key={attachment.id} aria-label={`View ${attachment.name}`} onClick={event => { trigger.current = event.currentTarget; setSelected(attachment); }}>
        <img src={attachmentContentUrl(attachment.id)} alt={attachment.name} width={attachment.width} height={attachment.height} loading="lazy" />
      </button>)}</div>
    {selected && <div ref={dialog} className="image-viewer" role="dialog" aria-modal="true" aria-label={selected.name} tabIndex={-1} onClick={close}>
      <button type="button" aria-label="Close image" onClick={close}>×</button>
      <img src={attachmentContentUrl(selected.id)} alt={selected.name} />
    </div>}
  </>;
}
