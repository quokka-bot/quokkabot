import { expect, it, vi } from "vitest";
import { bytesLabel, reportBody, reportResponse } from "../src/chat/report";

const input = { text: "An **untrusted** response\nwith [a link](https://example.com)", origin: "https://server.example.com:8443", taskId: "task-id",
  email: "support@quokkabot.com", supportUrl: "https://quokkabot.com/support" };
const body = "Report a response\n\nAn **untrusted** response\nwith [a link](https://example.com)\n\nServer: server.example.com:8443\nTask: task-id";
function device(available: boolean) {
  return { mailAvailable: vi.fn().mockResolvedValue(available), compose: vi.fn().mockResolvedValue({ status: "cancelled" }),
    copy: vi.fn().mockResolvedValue(undefined), open: vi.fn().mockResolvedValue(undefined) };
}
it("includes the exact response, server host and task id, without server credentials or paths", () => {
  expect(reportBody(input.text, input.origin, input.taskId)).toBe(body);
  expect(reportBody("Response", "https://user:password@server.example.com/private?token=secret", "task-id"))
    .toBe("Report a response\n\nResponse\n\nServer: server.example.com\nTask: task-id");
});
it("opens a mail preview addressed to support, and does nothing else when it is cancelled", async () => {
  const native = device(true);
  await reportResponse(input, native);
  expect(native.compose).toHaveBeenCalledExactlyOnceWith({ recipients: [input.email], subject: "Report a response", body });
  expect(native.copy).not.toHaveBeenCalled();
  expect(native.open).not.toHaveBeenCalled();
});
it("copies the same report before opening support when mail is unavailable", async () => {
  const native = device(false);
  native.open.mockImplementation(async () => { expect(native.copy).toHaveBeenCalledExactlyOnceWith(body); });
  await reportResponse(input, native);
  expect(native.compose).not.toHaveBeenCalled();
  expect(native.open).toHaveBeenCalledExactlyOnceWith(input.supportUrl);
});
it("does not claim a copy succeeded or open support if copying fails", async () => {
  const native = device(false);
  native.copy.mockRejectedValue(new Error("Copy failed"));
  await expect(reportResponse(input, native)).rejects.toThrow("Copy failed");
  expect(native.open).not.toHaveBeenCalled();
});
it("formats file sizes as the web does", () => {
  expect([0, 1023, 1024, 1536, 1048576].map(bytesLabel)).toEqual(["0 B", "1023 B", "1.0 KB", "1.5 KB", "1.0 MB"]);
});
