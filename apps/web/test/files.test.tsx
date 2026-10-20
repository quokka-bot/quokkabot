import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerView } from "@quokkabot/shared";
import { Files } from "../src/files.js";
import { agentId, at, hash, json } from "./fixtures.js";

const fileId = "66666666-6666-4666-8666-666666666666";
const downloads = {
  scope: "downloads", dir: "", nextCursor: null, entries: [{
    name: "invoice.pdf", path: "invoice.pdf", type: "file", bytes: 2048, modifiedAt: at,
    file: { fileId, name: "invoice.pdf", bytes: 2048, sha256: hash, mimeType: "application/pdf", sourceUrl: "https://billing.example.com/invoice", taskId: null, createdAt: at },
  }],
};
const workspace = { scope: "workspace", dir: "", nextCursor: null, entries: [{ name: "report.csv", path: "report.csv", type: "file", bytes: 12, modifiedAt: at, file: null }] };
const stopped = { error: { code: "computer_stopped", message: "The computer is stopped. Start it to see the workspace files." } };
const killed = { error: { code: "killed", message: "The kill switch is on. Release it and start the computer to see the workspace files." } };

let workspaceReply: () => Response;
const fetchMock = vi.fn<typeof fetch>();
let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input), "https://quokkabot.test");
    if (url.pathname !== `/api/agents/${agentId}/files`) throw new Error(`Unexpected fetch ${String(input)}`);
    return url.searchParams.get("scope") === "downloads" ? json(downloads) : workspaceReply();
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { client.clear(); vi.unstubAllGlobals(); });

function renderFiles(computer: ComputerView["state"]) {
  const view = (state: ComputerView["state"]) => <QueryClientProvider client={client}><Files agentId={agentId} computer={state} /></QueryClientProvider>;
  const result = render(view(computer));
  const section = (name: "Downloads" | "Workspace") => within(screen.getByRole("heading", { name }).closest("section")!);
  return { section, rerender: (state: ComputerView["state"]) => result.rerender(view(state)) };
}

describe("Library with the computer not running", () => {
  it("lists Downloads and says what to do for the workspace, with no error and no empty folder", async () => {
    workspaceReply = () => json(stopped, 409);
    const { section } = renderFiles("stopped");
    expect((await section("Workspace").findByText(stopped.error.message)).getAttribute("role")).toBe("status");
    expect(await section("Downloads").findByText("invoice.pdf")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("This folder is empty.")).toBeNull();
    expect(section("Workspace").queryByText("/")).toBeNull();
    expect(section("Downloads").getByText("/")).toBeTruthy();
  });

  it("says the kill switch is on", async () => {
    workspaceReply = () => json(killed, 409);
    const { section } = renderFiles("killed");
    expect((await section("Workspace").findByText(killed.error.message)).getAttribute("role")).toBe("status");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lists the workspace by itself once the computer runs", async () => {
    workspaceReply = () => json(stopped, 409);
    const { section, rerender } = renderFiles("stopped");
    await section("Workspace").findByText(stopped.error.message);
    workspaceReply = () => json(workspace);
    rerender("running");
    expect(await section("Workspace").findByText("report.csv")).toBeTruthy();
    expect(section("Workspace").queryByText(stopped.error.message)).toBeNull();
  });

  it("hides the last listing when a refresh finds the computer stopped", async () => {
    workspaceReply = () => json(workspace);
    const { section } = renderFiles("running");
    await section("Workspace").findByText("report.csv");
    workspaceReply = () => json(stopped, 409);
    fireEvent.click(section("Workspace").getByRole("button", { name: "Refresh" }));
    await section("Workspace").findByText(stopped.error.message);
    expect(section("Workspace").queryByText("report.csv")).toBeNull();
  });

  it("keeps any other failure an error", async () => {
    workspaceReply = () => json({ error: { code: "internal", message: "The server hit an error. It is in the log." } }, 500);
    const { section } = renderFiles("running");
    expect(await section("Workspace").findByRole("alert")).toHaveProperty("textContent", "The server hit an error. It is in the log.");
    await waitFor(() => expect(section("Workspace").queryByText("Loading files…")).toBeNull());
    expect(screen.queryByText("This folder is empty.")).toBeNull();
  });
});
