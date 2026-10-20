import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom has no layout and no ResizeObserver. Tests that need size changes stub it with their own.
// Assigned, not stubbed: vi.unstubAllGlobals() in a test file must not remove it.
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };

afterEach(() => { cleanup(); });
