import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Attachment, MAX_IMAGE_BYTES } from "@quokkabot/shared";
import { api } from "../src/api.js";
import { Composer } from "../src/chat.js";
import { OwnerImages, prepareImage } from "../src/chat-images.js";
import { agent, ownerRequest, task, taskId } from "./fixtures.js";

const attachment = Attachment.parse({ id: "66666666-6666-4666-8666-666666666666", name: "screen.png", mediaType: "image/png", bytes: 10, width: 10, height: 10 });
const imageFile = (name = "screen.png") => new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
let clients: QueryClient[];
let width = 10;
let height = 10;
const created = vi.fn();
const uploadImageRequest = api.uploadImage;
const createTaskRequest = api.createTask;
const originalUrl = URL;
class TestImage {
  naturalWidth = width; naturalHeight = height;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) { queueMicrotask(() => this.onload?.()); }
}
const revoke = vi.fn();
const createUrl = vi.fn(() => `blob:preview-${crypto.randomUUID()}`);
beforeEach(() => {
  clients = []; width = 10; height = 10; created.mockReset(); revoke.mockReset(); createUrl.mockClear();
  vi.stubGlobal("Image", TestImage);
  vi.stubGlobal("URL", class extends originalUrl { static override createObjectURL = createUrl; static override revokeObjectURL = revoke; });
  vi.spyOn(api, "uploadImage").mockResolvedValue(attachment);
  vi.spyOn(api, "createTask").mockResolvedValue(task);
  vi.spyOn(api, "reply").mockResolvedValue(task);
  vi.spyOn(api, "message").mockResolvedValue(task);
});
afterEach(() => { clients.forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function composer(mode: "new" | "reply" | "follow-up" = "new") {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } }); clients.push(client);
  return render(<QueryClientProvider client={client}><MemoryRouter><Composer agent={agent} task={mode === "new" ? null : mode === "reply" ? task : { ...task, state: "completed" }} ready openQuestion={mode === "reply" ? ownerRequest : null} waiting={mode === "reply"} startNew={vi.fn()} onCreated={created} /></MemoryRouter></QueryClientProvider>);
}
function paste(file: File) {
  return fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ kind: "file", getAsFile: () => file }] } });
}
function drop(file: File) { return fireEvent.drop(window, { dataTransfer: { types: ["Files"], files: [file] } }); }

describe("image preparation", () => {
  it("keeps a small image and preserves GIF bytes", async () => {
    const png = imageFile(); expect(await prepareImage(png)).toBe(png);
    const gif = new File(["GIF89a"], "motion.gif", { type: "image/gif" }); expect(await prepareImage(gif)).toBe(gif);
    expect(revoke).toHaveBeenCalled();
  });
  it("scales the long edge to 1568 and changes the extension when JPEG is needed", async () => {
    width = 4000; height = 2000;
    const context = { drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: "", globalCompositeOperation: "" };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const encode = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function(this: HTMLCanvasElement, callback, type) {
      expect(this.width).toBe(1568); expect(this.height).toBe(784);
      callback(new Blob([type === "image/jpeg" ? new Uint8Array([1, 2]) : new Uint8Array(MAX_IMAGE_BYTES + 1)], { type: type ?? "image/png" }));
    });
    const file = await prepareImage(imageFile());
    expect(file.name).toBe("screen.jpg"); expect(file.type).toBe("image/jpeg");
    expect(encode).toHaveBeenLastCalledWith(expect.any(Function), "image/jpeg", 0.85);
  });
  it("rejects unsupported files and oversized GIFs without re-encoding", async () => {
    await expect(prepareImage(new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }))).rejects.toThrow("PNG, JPEG");
    await expect(prepareImage(new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], "x.gif", { type: "image/gif" }))).rejects.toThrow("GIFs");
  });
});

describe("composer images", () => {
  it("pastes an image into a removable chip, while text paste stays native", async () => {
    composer();
    expect(fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ kind: "string", getAsFile: () => null }] } })).toBe(true);
    expect(paste(imageFile())).toBe(false);
    await screen.findByLabelText("Attachment screen.png");
    await waitFor(() => expect(api.uploadImage).toHaveBeenCalledWith(agent.id, expect.any(File)));
    fireEvent.click(screen.getByLabelText("Remove screen.png"));
    expect(screen.queryByLabelText("Attachment screen.png")).toBeNull();
    expect(revoke).toHaveBeenCalledWith(expect.stringContaining("blob:preview-"));
  });
  it("shows a full-panel drop overlay and catches a drop outside the composer", async () => {
    composer();
    fireEvent.dragEnter(window, { dataTransfer: { types: ["Files"] } });
    expect(screen.getByText("Drop images here")).toBeTruthy();
    expect(drop(imageFile())).toBe(false);
    expect(screen.queryByText("Drop images here")).toBeNull();
    expect(screen.getByLabelText("Attachment screen.png")).toBeTruthy();
    await waitFor(() => expect(api.uploadImage).toHaveBeenCalled());
  });
  it("selects multiple images through the attach button's picker", async () => {
    composer();
    const input = screen.getByLabelText("Choose images") as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    fireEvent.click(screen.getByLabelText("Attach images")); expect(click).toHaveBeenCalled();
    expect(input.accept).toBe("image/png,image/jpeg,image/gif,image/webp"); expect(input.multiple).toBe(true);
    fireEvent.change(input, { target: { files: [imageFile(), imageFile("other.png")] } });
    expect(screen.getByLabelText("Attachment other.png")).toBeTruthy();
    await waitFor(() => expect(api.uploadImage).toHaveBeenCalledTimes(2));
  });
  it("waits for an upload before sending its ids", async () => {
    let finish!: (value: Attachment) => void;
    vi.mocked(api.uploadImage).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    composer(); paste(imageFile());
    await waitFor(() => expect(api.uploadImage).toHaveBeenCalled());
    expect(screen.getByRole("status", { name: "Uploading screen.png" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(api.createTask).not.toHaveBeenCalled();
    await act(async () => finish(attachment));
    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith(agent.id, "", expect.any(String), [attachment.id]));
    await waitFor(() => expect(screen.queryByLabelText("Attachment screen.png")).toBeNull());
    expect(revoke).toHaveBeenCalled();
  });
  it("uploads a raw file then sends only its id over the owner API", async () => {
    vi.mocked(api.uploadImage).mockImplementation(uploadImageRequest);
    vi.mocked(api.createTask).mockImplementation(createTaskRequest);
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/attachments?")) return Response.json(attachment);
      if (url.endsWith("/tasks")) return Response.json(task);
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    composer(); paste(imageFile());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByLabelText("Send"));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/agents/${agent.id}/attachments?name=screen.png`);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: expect.any(File), headers: { "Content-Type": "image/png" } });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ prompt: "", attachmentIds: [attachment.id] });
    await waitFor(() => expect(screen.queryByLabelText("Attachment screen.png")).toBeNull());
  });
  it("blocks Send after an upload fails until the chip is removed", async () => {
    vi.mocked(api.uploadImage).mockRejectedValue(new Error("This image is too big."));
    composer(); paste(imageFile());
    await screen.findByText("This image is too big.");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Please look" } });
    expect((screen.getByLabelText("Send") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await act(async () => undefined); expect(api.createTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Remove screen.png"));
    expect((screen.getByLabelText("Send") as HTMLButtonElement).disabled).toBe(false);
  });
  it.each(["new", "reply", "follow-up"] as const)("sends images without text through the %s path", async mode => {
    composer(mode); paste(imageFile());
    await waitFor(() => expect(screen.queryByRole("status", { name: "Uploading screen.png" })).toBeNull());
    fireEvent.click(screen.getByLabelText("Send"));
    if (mode === "new") await waitFor(() => expect(api.createTask).toHaveBeenCalledWith(agent.id, "", expect.any(String), [attachment.id]));
    else await waitFor(() => expect(mode === "reply" ? api.reply : api.message).toHaveBeenCalledWith(taskId, "", [attachment.id]));
    await waitFor(() => expect(screen.queryByLabelText("Attachment screen.png")).toBeNull());
  });
  it("keeps drafts and previews when a send fails and revokes previews on unmount", async () => {
    vi.mocked(api.createTask).mockRejectedValue(new Error("Try again later."));
    const view = composer(); paste(imageFile());
    await waitFor(() => expect(screen.queryByRole("status", { name: "Uploading screen.png" })).toBeNull());
    fireEvent.click(screen.getByLabelText("Send")); await screen.findByText("Try again later.");
    expect(screen.getByLabelText("Attachment screen.png")).toBeTruthy();
    view.unmount(); expect(revoke).toHaveBeenCalled();
  });
  it("shows a removable error for a ninth image", async () => {
    composer();
    fireEvent.drop(window, { dataTransfer: { types: ["Files"], files: Array.from({ length: 9 }, (_, i) => imageFile(`${i}.png`)) } });
    expect(screen.getByText("Attach at most 8 images per message.")).toBeTruthy();
    expect((screen.getByLabelText("Send") as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(api.uploadImage).toHaveBeenCalledTimes(8));
  });
});

describe("owner image bubbles", () => {
  it("renders thumbnails and opens and closes a full-size in-app viewer", () => {
    render(<OwnerImages attachments={[attachment]} />);
    const thumbnail = screen.getByRole("img", { name: "screen.png" });
    expect(thumbnail.getAttribute("src")).toBe(`/api/attachments/${attachment.id}/content`);
    fireEvent.click(screen.getByLabelText("View screen.png"));
    expect(within(screen.getByRole("dialog")).getByRole("img")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" }); expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByLabelText("View screen.png")); fireEvent.click(screen.getByRole("dialog")); expect(screen.queryByRole("dialog")).toBeNull();
  });
});
