import { z } from "zod";
import { hostMatchesPattern, SiteDataClearResult } from "@quokkabot/shared";
import type { CdpConnection } from "./cdp.js";

// CDP's Cookie and CookieParam are different types. Restore only writable fields, while preserving
// expiry, security flags, priority and partition keys for cookies belonging to unrelated sites.
const Cookie = z.object({
  name: z.string(), value: z.string(), domain: z.string().min(1), path: z.string(),
  expires: z.number(), session: z.boolean(), secure: z.boolean(), httpOnly: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
  priority: z.enum(["Low", "Medium", "High"]).optional(),
  sameParty: z.boolean().optional(),
  sourceScheme: z.enum(["Unset", "NonSecure", "Secure"]).optional(),
  sourcePort: z.number().int().optional(),
  partitionKey: z.object({ topLevelSite: z.string(), hasCrossSiteAncestor: z.boolean() }).optional(),
  partitionKeyOpaque: z.boolean().optional(),
});
const CookieJar = z.object({ cookies: z.array(Cookie) });
const Targets = z.object({ targetInfos: z.array(z.object({ type: z.string(), url: z.string() })) });
export class SiteDataClearError extends Error {}

export async function clearSiteData(cdp: CdpConnection, patterns: readonly string[]): Promise<SiteDataClearResult> {
  let step = "Storage.getCookies";
  try {
    const { cookies } = CookieJar.parse(await cdp.send(step));
    const matches = (host: string) => patterns.some((pattern) => hostMatchesPattern(host, pattern));
    const kept: z.infer<typeof Cookie>[] = [];
    const origins = new Set<string>();
    let cookiesDeleted = 0;
    for (const cookie of cookies) {
      const domain = cookie.domain.replace(/^\./, "");
      if (matches(domain)) {
        cookiesDeleted += 1;
        origins.add(`http://${domain}`);
        origins.add(`https://${domain}`);
      } else kept.push(cookie);
    }

    step = "Target.getTargets";
    const targets = Targets.parse(await cdp.send(step));
    for (const target of targets.targetInfos) {
      if (target.type !== "page") continue;
      const url = new URL(target.url);
      if ((url.protocol === "http:" || url.protocol === "https:") && matches(url.hostname)) {
        // Retain nondefault ports, and clear both schemes even when only one is currently open.
        const authority = url.host;
        origins.add(`http://${authority}`);
        origins.add(`https://${authority}`);
      }
    }

    if (cookiesDeleted > 0) {
      step = "cookie preservation";
      const restored = kept.map((cookie) => {
        // Opaque partition keys cannot be represented by CookieParam. Refuse before changing the jar.
        if (cookie.partitionKeyOpaque) throw new Error("Cannot restore opaque partitioned cookies");
        const { session, expires, partitionKeyOpaque: _opaque, ...writable } = cookie;
        return { ...writable, ...(session ? {} : { expires }) };
      });
      step = "Storage.clearCookies";
      await cdp.send(step);
      if (restored.length > 0) {
        step = "Storage.setCookies";
        await cdp.send(step, { cookies: restored });
      }
    }
    const originsCleared = [...origins].sort();
    step = "Storage.clearDataForOrigin";
    for (const origin of originsCleared) await cdp.send(step, { origin, storageTypes: "all" });
    return SiteDataClearResult.parse({ cookiesDeleted, originsCleared });
  } catch {
    // A failure after clearing cookies can be partial. The caller must keep the attended session closing
    // and retry; no cookie values or page content belong in the error response.
    throw new SiteDataClearError(`site-data clear failed during ${step}`);
  }
}
