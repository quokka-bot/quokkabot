import { describe, expect, it } from "vitest";
import { isPublicAddress } from "../src/address.js";

function ipv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => (value >> shift & 255n).toString()).join(".");
}
function ipv6(value: bigint): string {
  return Array.from({ length: 8 }, (_, index) => (value >> BigInt((7 - index) * 16) & 65535n).toString(16)).join(":");
}

// These ranges are independent of the implementation's constants. Both ends and their immediate neighbours
// exercise masks and catch accidental over-blocking as well as SSRF gaps.
const v4Ranges: readonly [bigint, number][] = [
  [0x00000000n, 8], [0x0a000000n, 8], [0x64400000n, 10], [0x7f000000n, 8],
  [0xa9fe0000n, 16], [0xac100000n, 12], [0xc0000000n, 24], [0xc0000200n, 24],
  [0xc0586300n, 24], [0xc0a80000n, 16], [0xc6120000n, 15], [0xc6336400n, 24],
  [0xcb007100n, 24], [0xe0000000n, 4], [0xf0000000n, 4],
];
const v6Ranges: readonly [bigint, number][] = [
  [0n, 128], [1n, 128], [0x01000000000000000000000000000000n, 64],
  [0x20010000000000000000000000000000n, 32], [0x20010db8000000000000000000000000n, 32],
  [0xfc000000000000000000000000000000n, 7], [0xfe800000000000000000000000000000n, 10],
  [0xfec00000000000000000000000000000n, 10], [0xff000000000000000000000000000000n, 8],
];
function within(value: bigint, ranges: readonly [bigint, number][], bits: number): boolean {
  return ranges.some(([base, prefix]) => value >= base && value < base + (1n << BigInt(bits - prefix)));
}

describe("IPv4 range boundaries", () => {
  for (const [base, prefix] of v4Ranges) {
    const end = base + (1n << BigInt(32 - prefix)) - 1n;
    for (const address of [base - 1n, base, end, end + 1n].filter((n) => n >= 0n && n <= 0xffffffffn)) {
      it(`${ipv4(address)} beside ${ipv4(base)}/${prefix}`, () => {
        expect(isPublicAddress(ipv4(address))).toBe(!within(address, v4Ranges, 32));
      });
    }
  }
});

describe("IPv6 range boundaries", () => {
  for (const [base, prefix] of v6Ranges) {
    const end = base + (1n << BigInt(128 - prefix)) - 1n;
    for (const address of [base - 1n, base, end, end + 1n].filter((n) => n >= 0n && n < 1n << 128n)) {
      it(`${ipv6(address)} beside ${ipv6(base)}/${prefix}`, () => {
        expect(isPublicAddress(ipv6(address))).toBe(!within(address, v6Ranges, 128));
      });
    }
  }
});

describe("embedded IPv4 addresses", () => {
  it.each(v4Ranges)("blocks IPv4 prefix %s/%s through all embeddings", (base, prefix) => {
    const last = base + (1n << BigInt(32 - prefix)) - 1n;
    for (const address of [base, last]) {
      expect(isPublicAddress(`::ffff:${ipv4(address)}`)).toBe(false);
      expect(isPublicAddress(ipv6(0x0064ff9b000000000000000000000000n | address))).toBe(false);
      expect(isPublicAddress(ipv6(0x0064ff9b000100000000000000000000n | (address >> 16n) << 64n | (address & 0xffffn) << 40n))).toBe(false);
      expect(isPublicAddress(ipv6(0x20020000000000000000000000000000n | address << 80n))).toBe(false);
    }
  });
  it.each(["::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "64:ff9b:1:808:8:800::", "2002:808:808::1"])("allows public embedded IPv4 %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
  it.each(["::fffe:ffff:ffff", "::1:0:0:0", "64:ff9a:ffff:ffff:ffff:ffff:ffff:ffff", "64:ff9b::1:0:0", "64:ff9b:0:ffff:ffff:ffff:ffff:ffff", "64:ff9b:2::", "2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "2003::"])("allows outside embedding prefix %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

it("blocks configured host addresses, their canonical equivalents and embedded aliases", () => {
  expect(isPublicAddress("8.8.8.8", ["8.8.8.8"])).toBe(false);
  expect(isPublicAddress("::ffff:808:808", ["8.8.8.8"])).toBe(false);
  expect(isPublicAddress("64:ff9b::808:808", ["8.8.8.8"])).toBe(false);
  expect(isPublicAddress("2002:808:808::1", ["8.8.8.8"])).toBe(false);
  expect(isPublicAddress("8.8.8.8", ["::ffff:808:808"])).toBe(false);
  expect(isPublicAddress("2606:4700::1111", ["2606:4700:0:0:0:0:0:1111"])).toBe(false);
  expect(isPublicAddress("2606:4700::1112", ["2606:4700::1111"])).toBe(true);
});
it.each(["", "hello", "127.01.0.1", "999.1.1.1", "2606:4700::1%lo0"])("fails closed for invalid DNS address %s", (address) => {
  expect(isPublicAddress(address)).toBe(false);
});
