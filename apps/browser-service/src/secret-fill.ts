import { z } from "zod";
import { hostMatchesPattern } from "@quokkabot/shared";
import type { SecretFillRequest } from "@quokkabot/shared";

export class SecretFillError extends Error {
  constructor(readonly status: "blocked" | "invalid" | "failed", message: string) { super(message); }
}

interface FrameTree {
  frame: { id: string; securityOrigin: string };
  childFrames?: FrameTree[] | undefined;
}
const FrameTreeSchema: z.ZodType<FrameTree> = z.lazy(() => z.object({
  frame: z.object({ id: z.string().min(1), securityOrigin: z.string() }),
  childFrames: z.array(FrameTreeSchema).optional(),
}));
const Field = z.object({
  tag: z.string(), type: z.string(), autocomplete: z.string(), maxLength: z.number().int(),
  inputMode: z.string(), disabled: z.boolean(), readOnly: z.boolean(), hints: z.string(),
});
type Field = z.infer<typeof Field>;
export type SecretFillSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
type FrameSend = (frameId: string) => Promise<SecretFillSend>;

// Reads the focused element's metadata, never its value. Shared by the inspection and the insertion below, so both
// see the same element.
const FOCUSED_FIELD_SOURCE = `function focusedField() {
  if (!document.hasFocus()) return null;
  let element = document.activeElement;
  while (element && element.shadowRoot && element.shadowRoot.activeElement) element = element.shadowRoot.activeElement;
  // Parent documents also report focus when an iframe has it, so leave iframe hosts to their own document.
  if (!element || element.localName === "iframe" || element.localName === "frame") return null;
  const input = element instanceof HTMLInputElement;
  const hints = input
    ? [element.name, element.id, element.placeholder, element.getAttribute("aria-label") || ""].join(" ").toLowerCase()
    : "";
  return {
    element,
    field: {
      tag: element.localName,
      type: input ? element.type : "",
      autocomplete: input ? element.autocomplete : "",
      maxLength: input ? element.maxLength : -1,
      inputMode: input ? element.inputMode : "",
      disabled: input ? element.disabled : false,
      readOnly: input ? element.readOnly : false,
      hints
    }
  };
}`;

// Which fields may receive which value. One source, used in the service and inside the page.
// A code goes only into a field that says it takes one: a TOTP typed into a search box would land in a URL.
const FIELD_RULE_SOURCE = `function fieldMatches(field, kind) {
  if (field.tag !== "input" || field.disabled || field.readOnly) return false;
  if (kind === "password") return field.type === "password";
  if (kind === "username") return field.type === "text" || field.type === "email" || field.type === "tel";
  if (field.type === "password") return false;
  if (field.autocomplete.toLowerCase().split(/\\s+/).includes("one-time-code")) return true;
  if (field.type !== "text" && field.type !== "number" && field.type !== "tel") return false;
  if (field.inputMode.toLowerCase() === "numeric") return true;
  if (field.maxLength >= 4 && field.maxLength <= 10) return true;
  return /(^|[^a-z])(code|otp|totp|2fa|mfa|token|verification|verify|authenticator|pin)([^a-z]|$)/.test(field.hints);
}`;

// This fixed expression runs only in a service-created isolated world.
export const FOCUSED_FIELD_EXPRESSION = `(() => { ${FOCUSED_FIELD_SOURCE}; const found = focusedField(); return found ? found.field : null; })()`;

// Checks the site, the focused element and its kind, and inserts the value, in one task of the page: no page script
// can move focus or change the field between the check and the insertion. Runs in the isolated world of the frame
// that was inspected; if that frame navigated, its context is gone and the call fails without typing.
export const INSERT_FUNCTION = `function (kind, expectedOrigin, value) {
  ${FOCUSED_FIELD_SOURCE}
  ${FIELD_RULE_SOURCE}
  if (location.origin !== expectedOrigin) return "wrong site";
  const found = focusedField();
  if (!found || !fieldMatches(found.field, kind)) return "wrong field kind";
  const element = found.element;
  element.select();
  if (!document.execCommand("insertText", false, value)) return "not inserted";
  return element.value === value ? "ok" : "not inserted";
}`;

const fieldMatchesInService = new Function(`${FIELD_RULE_SOURCE}; return fieldMatches;`)() as (field: Field, kind: SecretFillRequest["kind"]) => boolean;

interface FocusedTarget { origin: string; frameSend: SecretFillSend; contextId: number }

async function checkFocusedField(send: SecretFillSend, forFrame: FrameSend, request: SecretFillRequest, allowLocalhostHttp: boolean): Promise<FocusedTarget> {
  const { frameTree } = z.object({ frameTree: FrameTreeSchema }).parse(await send("Page.getFrameTree"));
  const focused: { origin: string; field: Field; frameSend: SecretFillSend; contextId: number }[] = [];
  async function inspect(tree: FrameTree): Promise<void> {
    const frameSend = await forFrame(tree.frame.id);
    const world = z.object({ executionContextId: z.number().int().positive() }).parse(await frameSend("Page.createIsolatedWorld", {
      frameId: tree.frame.id, worldName: "quokkabot-secret-fill", grantUniveralAccess: false,
    }));
    const evaluated = z.object({
      result: z.object({ type: z.string(), value: Field.nullable() }), exceptionDetails: z.unknown().optional(),
    }).parse(await frameSend("Runtime.evaluate", {
      expression: FOCUSED_FIELD_EXPRESSION, contextId: world.executionContextId,
      returnByValue: true, silent: true,
    }));
    if (evaluated.exceptionDetails !== undefined || evaluated.result.type !== "object") {
      throw new SecretFillError("blocked", "wrong field kind");
    }
    if (evaluated.result.value !== null) {
      focused.push({ origin: tree.frame.securityOrigin, field: evaluated.result.value, frameSend, contextId: world.executionContextId });
    }
    for (const child of tree.childFrames ?? []) await inspect(child);
  }
  await inspect(frameTree);
  if (focused.length !== 1) throw new SecretFillError("blocked", "wrong field kind");
  const selected = focused[0]!;
  let origin: URL;
  try { origin = new URL(selected.origin); }
  catch { throw new SecretFillError("blocked", "wrong site"); }
  // Production requires TLS. Local fixture hosts may use HTTP, but still need an explicit allowed pattern.
  const localTestHost = origin.hostname === "localhost" || origin.hostname.endsWith(".localhost");
  if (origin.protocol !== "https:" && !(allowLocalhostHttp && origin.protocol === "http:" && localTestHost)) {
    throw new SecretFillError("blocked", `wrong site: ${origin.origin} is not HTTPS`);
  }
  if (!request.allowedPatterns.some((pattern) => hostMatchesPattern(origin.hostname, pattern))) {
    throw new SecretFillError("blocked", `wrong site: the field is on ${origin.hostname}`);
  }
  if (!fieldMatchesInService(selected.field, request.kind)) throw new SecretFillError("blocked", "wrong field kind");
  return { origin: origin.origin, frameSend: selected.frameSend, contextId: selected.contextId };
}

export async function fillSecret(send: SecretFillSend, forFrame: FrameSend, request: SecretFillRequest, allowLocalhostHttp = false): Promise<void> {
  const target = await checkFocusedField(send, forFrame, request, allowLocalhostHttp);
  const inserted = z.object({ result: z.object({ value: z.string() }), exceptionDetails: z.unknown().optional() }).parse(
    await target.frameSend("Runtime.callFunctionOn", {
      functionDeclaration: INSERT_FUNCTION,
      executionContextId: target.contextId,
      arguments: [{ value: request.kind }, { value: target.origin }, { value: request.value }],
      returnByValue: true,
      silent: true,
    }),
  );
  if (inserted.exceptionDetails !== undefined) throw new SecretFillError("failed", "the field did not accept the value");
  const outcome = inserted.result.value;
  if (outcome === "wrong site" || outcome === "wrong field kind") throw new SecretFillError("blocked", outcome);
  if (outcome !== "ok") throw new SecretFillError("failed", "the field did not accept the value");
  if (request.submit) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  }
}
