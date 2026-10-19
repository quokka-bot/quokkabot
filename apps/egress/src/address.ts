import { isIP } from "node:net";

interface Address {
  family: 4 | 6;
  value: bigint;
}

function parseAddress(text: string): Address | null {
  // Scoped addresses are not valid Internet destinations, even on an otherwise public prefix.
  if (text.includes("%")) return null;
  const family = isIP(text);
  if (family === 4) {
    const value = text.split(".").reduce((result, octet) => (result << 8n) | BigInt(octet), 0n);
    return { family, value };
  }
  if (family !== 6) return null;

  let expanded = text.toLowerCase();
  if (expanded.includes(".")) {
    const lastColon = expanded.lastIndexOf(":");
    const embedded = parseAddress(expanded.slice(lastColon + 1));
    if (embedded === null || embedded.family !== 4) return null;
    expanded = `${expanded.slice(0, lastColon)}:${(embedded.value >> 16n).toString(16)}:${(embedded.value & 0xffffn).toString(16)}`;
  }
  const halves = expanded.split("::");
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves[1] === undefined || halves[1] === "" ? [] : halves[1].split(":");
  const words = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return { family: 6, value: words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n) };
}

function inPrefix(value: bigint, base: bigint, prefix: number, bits: number): boolean {
  const shift = BigInt(bits - prefix);
  return value >> shift === base >> shift;
}

const V4_BLOCKS: readonly [bigint, number][] = [
  [0x00000000n, 8], [0x0a000000n, 8], [0x64400000n, 10], [0x7f000000n, 8],
  [0xa9fe0000n, 16], [0xac100000n, 12], [0xc0000000n, 24], [0xc0000200n, 24],
  [0xc0586300n, 24], [0xc0a80000n, 16], [0xc6120000n, 15], [0xc6336400n, 24],
  [0xcb007100n, 24], [0xe0000000n, 4], [0xf0000000n, 4],
];
const V6_BLOCKS: readonly [bigint, number][] = [
  [0n, 128], [1n, 128], [0x01000000000000000000000000000000n, 64],
  [0x20010000000000000000000000000000n, 32], [0x20010db8000000000000000000000000n, 32],
  [0xfc000000000000000000000000000000n, 7], [0xfe800000000000000000000000000000n, 10],
  [0xfec00000000000000000000000000000n, 10], [0xff000000000000000000000000000000n, 8],
];

function embeddedIpv4(value: bigint): bigint | null {
  if (inPrefix(value, 0xffff00000000n, 96, 128)) return value & 0xffffffffn;
  if (inPrefix(value, 0x0064ff9b000000000000000000000000n, 96, 128)) return value & 0xffffffffn;
  if (inPrefix(value, 0x0064ff9b000100000000000000000000n, 48, 128)) {
    // RFC 6052 /48 layout: 16 IPv4 bits, the reserved u octet, then 16 IPv4 bits.
    return ((value >> 64n) & 0xffffn) << 16n | ((value >> 40n) & 0xffffn);
  }
  if (inPrefix(value, 0x20020000000000000000000000000000n, 16, 128)) return (value >> 80n) & 0xffffffffn;
  return null;
}

/** Invalid input is refused too. IPv4 aliases cannot bypass the host's own address denylist. */
export function isPublicAddress(text: string, hostAddresses: readonly string[] = []): boolean {
  const address = parseAddress(text);
  if (address === null) return false;
  const hosts = hostAddresses.map((host) => {
    const parsed = parseAddress(host);
    if (parsed === null) throw new Error("Invalid configured host address");
    return parsed;
  });
  const embedded = address.family === 6 ? embeddedIpv4(address.value) : null;
  const ipv4 = address.family === 4 ? address.value : embedded;
  if (hosts.some((host) => {
    if (host.family === address.family && host.value === address.value) return true;
    const hostIpv4 = host.family === 4 ? host.value : embeddedIpv4(host.value);
    return ipv4 !== null && hostIpv4 !== null && ipv4 === hostIpv4;
  })) return false;
  if (ipv4 !== null && V4_BLOCKS.some(([base, prefix]) => inPrefix(ipv4, base, prefix, 32))) return false;
  if (address.family === 6 && V6_BLOCKS.some(([base, prefix]) => inPrefix(address.value, base, prefix, 128))) return false;
  return true;
}
