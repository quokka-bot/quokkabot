import { z } from "zod";
import { hostMatchesPattern } from "@quokkabot/shared";
import type { OwnerFillRequest, SecretFillRequest } from "@quokkabot/shared";

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
const FIELD_RULE_SOURCE = `function fieldMatches(field, kind, owner = false) {
  if (field.tag !== "input" || field.disabled || field.readOnly) return false;
  if (kind === "password") return field.type === "password";
  if (kind === "username") return field.type === "text" || field.type === "email" || field.type === "tel";
  if (field.type === "password") return false;
  if (owner && (field.type !== "text" && field.type !== "number" && field.type !== "tel" ||
      /(zip|postal|post[ _-]*code|phone)/.test(field.hints))) return false;
  if (field.autocomplete.toLowerCase().split(/\\s+/).includes("one-time-code")) return true;
  if (field.type !== "text" && field.type !== "number" && field.type !== "tel") return false;
  if (!owner && field.inputMode.toLowerCase() === "numeric") return true;
  if (!owner && field.maxLength >= 4 && field.maxLength <= 10) return true;
  if (!owner && /(^|[^a-z])token([^a-z]|$)/.test(field.hints)) return true;
  return /(^|[^a-z])(code|otp|totp|2fa|mfa|verification|verify|authenticator|pin)([^a-z]|$)/.test(field.hints);
}`;

// Check composed ancestors too: an inert shadow host must not accept an owner value.
const VISIBLE_FIELD_SOURCE = `function visibleField(element) {
  if (!element.isConnected || element.ownerDocument !== document || document.visibilityState !== "visible") return false;
  for (let ancestor = element; ancestor; ancestor = ancestor.parentElement || ancestor.getRootNode().host) {
    const style = getComputedStyle(ancestor);
    if (ancestor.hidden || ancestor.inert || style.display === "none" || style.visibility !== "visible" || style.opacity === "0") return false;
  }
  if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return false;
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
}`;
export const OWNER_ELEMENT_EXPRESSION = `(() => { ${FOCUSED_FIELD_SOURCE}; const found = focusedField(); return found ? found.element : null; })()`;
export const OWNER_FIELD_FUNCTION = `function () {
  ${FOCUSED_FIELD_SOURCE}
  ${VISIBLE_FIELD_SOURCE}
  const found = focusedField();
  return found && found.element === this && visibleField(this) ? found.field : null;
}`;

// This fixed expression runs only in a service-created isolated world.
export const FOCUSED_FIELD_EXPRESSION = `(() => { ${FOCUSED_FIELD_SOURCE}; const found = focusedField(); return found ? found.field : null; })()`;

// Checks the site, the focused element and its kind, and inserts the value, in one task of the page: no page script
// can move focus or change the field between the check and the insertion. Runs in the isolated world of the frame
// that was inspected; if that frame navigated, its context is gone and the call fails without typing.
export const INSERT_FUNCTION = `function (kind, expectedOrigin, value, owner = false, allowLocalhostHttp = false, deadline = 0) {
  ${FOCUSED_FIELD_SOURCE}
  ${FIELD_RULE_SOURCE}
  ${VISIBLE_FIELD_SOURCE}
  if (owner && Date.now() >= deadline) return "expired insertion";
  if (location.origin !== expectedOrigin) return "wrong site";
  if (owner) {
    const origin = new URL(location.origin);
    const localTestHost = origin.hostname === "localhost" || origin.hostname.endsWith(".localhost");
    if (origin.protocol !== "https:" && !(allowLocalhostHttp && origin.protocol === "http:" && localTestHost)) return "wrong site";
  }
  const found = focusedField();
  if (!found || !fieldMatches(found.field, kind, owner)) return "wrong field kind";
  const element = found.element;
  if (owner && (element !== this || !visibleField(element))) return "wrong field kind";
  element.select();
  if (owner && (Date.now() >= deadline || focusedField()?.element !== this || !visibleField(element))) return "expired insertion";
  if (!document.execCommand("insertText", false, value)) return "not inserted";
  return element.value === value ? "ok" : "not inserted";
}`;

const fieldMatchesInService = new Function(`${FIELD_RULE_SOURCE}; return fieldMatches;`)() as (field: Field, kind: SecretFillRequest["kind"], owner?: boolean) => boolean;

export interface FocusedTarget { origin: string; frameSend: SecretFillSend; contextId: number; frameId: string; objectId?: string }

export async function focusedFields(send: SecretFillSend, forFrame: FrameSend, owner = false, captured: FocusedTarget[] = []): Promise<(FocusedTarget & { field: Field })[]> {
  const { frameTree } = z.object({ frameTree: FrameTreeSchema }).parse(await send("Page.getFrameTree"));
  const focused: (FocusedTarget & { field: Field })[] = [];
  async function inspect(tree: FrameTree): Promise<void> {
    const frameSend = await forFrame(tree.frame.id);
    const world = z.object({ executionContextId: z.number().int().positive() }).parse(await frameSend("Page.createIsolatedWorld", {
      frameId: tree.frame.id, worldName: "quokkabot-secret-fill", grantUniveralAccess: false,
    }));
    const target: FocusedTarget = { origin: tree.frame.securityOrigin, frameSend, contextId: world.executionContextId, frameId: tree.frame.id };
    let metadata: unknown;
    if (owner) {
      const evaluated = z.object({
        result: z.object({ objectId: z.string().optional(), subtype: z.string().optional() }), exceptionDetails: z.unknown().optional(),
      }).parse(await frameSend("Runtime.evaluate", {
        expression: OWNER_ELEMENT_EXPRESSION, contextId: target.contextId, returnByValue: false, silent: true,
      }));
      if (evaluated.exceptionDetails !== undefined) throw new SecretFillError("blocked", "wrong field kind");
      if (evaluated.result.objectId !== undefined) {
        target.objectId = evaluated.result.objectId;
        captured.push(target);
        metadata = await frameSend("Runtime.callFunctionOn", {
          objectId: target.objectId, functionDeclaration: OWNER_FIELD_FUNCTION, returnByValue: true, silent: true,
        });
        // An unsuitable or invisible focused field still makes the overall inspection fail closed.
        if (z.object({ result: z.object({ value: z.unknown() }) }).parse(metadata).result.value === null) {
          throw new SecretFillError("blocked", "wrong field kind");
        }
      } else if (evaluated.result.subtype !== "null") throw new SecretFillError("blocked", "wrong field kind");
    } else {
      metadata = await frameSend("Runtime.evaluate", {
        expression: FOCUSED_FIELD_EXPRESSION, contextId: target.contextId, returnByValue: true, silent: true,
      });
    }
    if (metadata !== undefined) {
      const evaluated = z.object({ result: z.object({ value: Field.nullable() }), exceptionDetails: z.unknown().optional() }).parse(metadata);
      if (evaluated.exceptionDetails !== undefined) throw new SecretFillError("blocked", "wrong field kind");
      if (evaluated.result.value !== null) focused.push({ ...target, field: evaluated.result.value });
    }
    for (const child of tree.childFrames ?? []) await inspect(child);
  }
  await inspect(frameTree);
  return focused;
}

function secureOrigin(value: string, allowLocalhostHttp: boolean): URL {
  let origin: URL;
  try { origin = new URL(value); }
  catch { throw new SecretFillError("blocked", "wrong site"); }
  const localTestHost = origin.hostname === "localhost" || origin.hostname.endsWith(".localhost");
  if (origin.protocol !== "https:" && !(allowLocalhostHttp && origin.protocol === "http:" && localTestHost)) {
    throw new SecretFillError("blocked", `wrong site: ${origin.origin} is not HTTPS`);
  }
  return origin;
}

async function checkFocusedField(send: SecretFillSend, forFrame: FrameSend, request: SecretFillRequest, allowLocalhostHttp: boolean): Promise<FocusedTarget> {
  const focused = await focusedFields(send, forFrame);
  if (focused.length !== 1) throw new SecretFillError("blocked", "wrong field kind");
  const selected = focused[0]!;
  const origin = secureOrigin(selected.origin, allowLocalhostHttp);
  if (!request.allowedPatterns.some((pattern) => hostMatchesPattern(origin.hostname, pattern))) {
    throw new SecretFillError("blocked", `wrong site: the field is on ${origin.hostname}`);
  }
  if (!fieldMatchesInService(selected.field, request.kind)) throw new SecretFillError("blocked", "wrong field kind");
  return { ...selected, origin: origin.origin };
}

export async function fillSecret(send: SecretFillSend, forFrame: FrameSend, request: SecretFillRequest, allowLocalhostHttp = false): Promise<void> {
  const target = await checkFocusedField(send, forFrame, request, allowLocalhostHttp);
  await insert(target, send, request, false, allowLocalhostHttp);
}

// Count all focused elements, including unsuitable fields, before selecting one across Chrome's page targets.
export function ownerTarget<T extends FocusedTarget & { field: Field }>(focused: T[], allowLocalhostHttp: boolean): T & { kind: OwnerFillRequest["kind"] } {
  if (focused.length !== 1) throw new SecretFillError("blocked", "wrong field kind");
  const selected = focused[0]!;
  let origin: URL;
  try { origin = secureOrigin(selected.origin, allowLocalhostHttp); }
  catch { throw new SecretFillError("blocked", "wrong site"); }
  const kind = fieldMatchesInService(selected.field, "password", true) ? "password"
    : fieldMatchesInService(selected.field, "code", true) ? "code" : null;
  if (kind === null) throw new SecretFillError("blocked", "wrong field kind");
  return { ...selected, origin: origin.origin, kind };
}

export async function fillOwner(target: FocusedTarget & { kind: OwnerFillRequest["kind"] }, send: SecretFillSend, request: OwnerFillRequest, allowLocalhostHttp: boolean, deadline: number): Promise<void> {
  if (!target.objectId) throw new SecretFillError("blocked", "wrong field kind");
  if (target.kind !== request.kind) throw new SecretFillError("blocked", "wrong field kind");
  await insert(target, send, request, true, allowLocalhostHttp, deadline);
}

async function insert(target: FocusedTarget, send: SecretFillSend, request: Pick<SecretFillRequest, "kind" | "value" | "submit">, owner: boolean, allowLocalhostHttp: boolean, deadline = 0): Promise<void> {
  const inserted = z.object({ result: z.object({ value: z.string() }), exceptionDetails: z.unknown().optional() }).parse(
    await target.frameSend("Runtime.callFunctionOn", {
      functionDeclaration: INSERT_FUNCTION,
      ...(owner ? { objectId: target.objectId } : { executionContextId: target.contextId }),
      arguments: [{ value: request.kind }, { value: target.origin }, { value: request.value }, ...(owner ? [{ value: true }, { value: allowLocalhostHttp }, { value: deadline }] : [])],
      returnByValue: true,
      silent: true,
    }),
  );
  if (inserted.exceptionDetails !== undefined) throw new SecretFillError("failed", "the field did not accept the value");
  const outcome = inserted.result.value;
  if (outcome === "expired insertion") throw new SecretFillError("blocked", "no takeover");
  if (outcome === "wrong site" || outcome === "wrong field kind") throw new SecretFillError("blocked", outcome);
  if (outcome !== "ok") throw new SecretFillError("failed", "the field did not accept the value");
  if (request.submit) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  }
}
