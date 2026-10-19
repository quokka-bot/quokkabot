import { z } from "zod";

// Identifiers are UUIDs issued by the control plane. The model never chooses an agent, task or run id: the
// server derives them from the authenticated caller.
export const Uuid = z.uuid();
export type Uuid = z.infer<typeof Uuid>;

export const AgentId = Uuid.brand<"AgentId">();
export type AgentId = z.infer<typeof AgentId>;
export const TaskId = Uuid.brand<"TaskId">();
export type TaskId = z.infer<typeof TaskId>;
export const RunId = Uuid.brand<"RunId">();
export type RunId = z.infer<typeof RunId>;
export const FileId = Uuid.brand<"FileId">();
export type FileId = z.infer<typeof FileId>;
export const DownloadId = Uuid.brand<"DownloadId">();
export type DownloadId = z.infer<typeof DownloadId>;
export const OwnerRequestId = Uuid.brand<"OwnerRequestId">();
export type OwnerRequestId = z.infer<typeof OwnerRequestId>;
export const DomainRequestId = Uuid.brand<"DomainRequestId">();
export type DomainRequestId = z.infer<typeof DomainRequestId>;

// Opaque browser handles issued by the browser service. They never start with "-", so they cannot be read as a
// command-line option by agent-browser.
export const TabRef = z.string().regex(/^t[0-9]{1,6}$/, "tab handle like t1");
export type TabRef = z.infer<typeof TabRef>;
export const ElementRef = z.string().regex(/^e[0-9]{1,6}$/, "element handle like e12 from the latest snapshot");
export type ElementRef = z.infer<typeof ElementRef>;
export const SnapshotGeneration = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export type SnapshotGeneration = z.infer<typeof SnapshotGeneration>;

const MAX_URL_LENGTH = 4096;

// Only http and https. No credentials in the URL, no internal browser pages, no other schemes.
export const HttpUrl = z
  .string()
  .max(MAX_URL_LENGTH)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.username !== "" || url.password !== "") return false;
    return url.hostname.length > 0;
  }, "an absolute http or https URL without credentials");
export type HttpUrl = z.infer<typeof HttpUrl>;

// A hostname as typed by people and models: lowercase ASCII (IDNA already converted), at least one dot, no port.
const HOST_LABEL = "(?!-)[a-z0-9-]{1,63}(?<!-)";
const HOSTNAME_RE = new RegExp(`^(?=.{1,253}$)${HOST_LABEL}(\\.${HOST_LABEL})+$`);
export const Hostname = z
  .string()
  .transform((value) => value.trim().toLowerCase().replace(/\.$/, ""))
  .pipe(
    z
      .string()
      .regex(HOSTNAME_RE, "a hostname such as billing.example.com")
      // A numeric last label is an IP address, not a name.
      .refine((host) => !/^[0-9]+$/.test(host.split(".").at(-1) ?? ""), "a hostname, not an IP address"),
  );
export type Hostname = z.infer<typeof Hostname>;

// A domain rule pattern: an exact host, or "*.example.com" which also matches example.com itself.
export const DomainPattern = z
  .string()
  .transform((value) => value.trim().toLowerCase().replace(/\.$/, ""))
  .pipe(
    z
      .string()
      .regex(new RegExp(`^(\\*\\.)?${HOST_LABEL}(\\.${HOST_LABEL})+$`), "example.com or *.example.com")
      .max(255)
      .refine((host) => !/^[0-9]+$/.test(host.split(".").at(-1) ?? ""), "a domain, not an IP address"),
  );
export type DomainPattern = z.infer<typeof DomainPattern>;

// A path relative to a pre-opened root (the workspace or the downloads folder). Normalised; never absolute, never
// escaping, never containing NUL, backslashes or empty segments.
export const RelPath = z
  .string()
  .max(1024)
  .refine((value) => {
    if (value === "" || value === ".") return true;
    if (value.startsWith("/") || value.startsWith("-")) return false;
    if (value.includes("\0") || value.includes("\\")) return false;
    const segments = value.split("/");
    return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
  }, "a relative path inside the root, without '..' or a leading '/'");
export type RelPath = z.infer<typeof RelPath>;

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256Hex = z.infer<typeof Sha256Hex>;

export const IsoTime = z.iso.datetime({ offset: true });
export type IsoTime = z.infer<typeof IsoTime>;

// Owner's model choice for an agent. Effort levels as the pinned Claude Code release accepts them.
export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof Effort>;
export const ModelId = z.string().regex(/^[a-z0-9][a-z0-9.\-]{1,80}$/);
export type ModelId = z.infer<typeof ModelId>;
