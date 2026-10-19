import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { entryFromModuleUrl, holdsReload, NewVersion } from "../src/app-version.js";

const running = "assets/index-OLD11111.js";
const deployed = "assets/index-NEW22222.js";
let served = running;
let focused = true;
const fetchMock = vi.fn<typeof fetch>();
const reload = vi.fn();

beforeEach(() => {
  served = running; focused = true;
  sessionStorage.clear();
  reload.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async input => {
    if (String(input) !== "/version.json") throw new Error(`Unexpected fetch ${String(input)}`);
    return new Response(JSON.stringify({ entry: served }), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

function blur() { focused = false; act(() => { fireEvent.blur(window); }); }

describe("new app version", () => {
  it("reads the running entry from the entry module's URL", () => {
    expect(entryFromModuleUrl("https://quokkabot.test/assets/index-CjVGBy6t.js")).toBe("assets/index-CjVGBy6t.js");
  });

  it("stays quiet while the server has the running app", async () => {
    render(<NewVersion entry={running} reload={reload} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/version.json", expect.objectContaining({ cache: "no-store" })));
    blur();
    expect(screen.queryByRole("status")).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it("offers a reload while the owner is looking and reloads by itself once the window is in the background", async () => {
    served = deployed;
    render(<NewVersion entry={running} reload={reload} />);
    expect((await screen.findByRole("status")).textContent).toContain("Quokka Bot was updated.");
    expect(reload).not.toHaveBeenCalled();
    blur();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("quokkabot-reloaded-for")).toBe(deployed);
  });

  it("reloads on the button", async () => {
    served = deployed;
    render(<NewVersion entry={running} reload={reload} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads by itself over text the owner typed", async () => {
    served = deployed;
    render(<><textarea aria-label="Message" /><NewVersion entry={running} reload={reload} /></>);
    await screen.findByRole("status");
    fireEvent.input(screen.getByLabelText("Message"), { target: { value: "half a message" } });
    expect(holdsReload()).toBe(true);
    blur();
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads over a value the app filled in", async () => {
    served = deployed;
    render(<><input aria-label="Username" defaultValue="owner@example.com" /><NewVersion entry={running} reload={reload} /></>);
    await screen.findByRole("status");
    expect(holdsReload()).toBe(false);
    blur();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads by itself over a terminal, takeover or image draft", async () => {
    served = deployed;
    render(<><div data-hold-reload="" /><NewVersion entry={running} reload={reload} /></>);
    await screen.findByRole("status");
    blur();
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads by itself only once for the same version", async () => {
    served = deployed;
    sessionStorage.setItem("quokkabot-reloaded-for", deployed);
    render(<NewVersion entry={running} reload={reload} />);
    await screen.findByRole("status");
    blur();
    expect(reload).not.toHaveBeenCalled();
  });

  it("keeps checking when the server is restarting", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("Bad Gateway", { status: 502 }));
    render(<NewVersion entry={running} reload={reload} />);
    await waitFor(() => expect(console.warn).toHaveBeenCalledWith("Quokka Bot version check failed", expect.any(Error)));
    served = deployed;
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect((await screen.findByRole("status")).textContent).toContain("Quokka Bot was updated.");
  });
});
