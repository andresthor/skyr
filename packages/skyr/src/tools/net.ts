/**
 * Address, URL and signal helpers for the web tools. Free of Pi imports, so the module stays safe to
 * load from a launcher's static graph.
 */
import { BlockList, isIP } from "node:net";

/** Composes the caller's signal with a deadline; no timers survive an abort. */
export function withTimeout(
  signal: AbortSignal | undefined,
  ms: number,
): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(ms)])
    : AbortSignal.timeout(ms);
}

/** Origin and path only, so query-string keys and userinfo never reach model-visible text. */
export function redactUrl(u: string): string {
  try {
    const url = new URL(u);
    return url.origin + url.pathname;
  } catch {
    return "<invalid url>";
  }
}

/** Ranges no public host can legitimately answer from, written as the registries publish them. */
const BLOCKED_IPV4 = [
  // unroutable
  "0.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16", // cloud metadata lives here

  // private and shared
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",

  // IETF reserved
  "192.0.0.0/24",
  "192.88.99.0/24",
  "198.18.0.0/15", // also what fake-IP TUN proxies hand out
  "224.0.0.0/4",
  "240.0.0.0/4",

  // documentation and test nets
  "192.0.2.0/24",
  "198.51.100.0/24",
  "203.0.113.0/24",
];

/**
 * IPv6-native ranges only: BlockList applies the IPv4 table above to IPv4-mapped addresses
 * (`::ffff:a.b.c.d`) on its own.
 */
const BLOCKED_IPV6 = [
  // unroutable
  "::/96", // unspecified, ::1, and deprecated IPv4-compatible
  "fe80::/10",
  "fec0::/10", // deprecated site-local

  // private
  "fc00::/7",

  // embedded IPv4, refused whole rather than unwrapped
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "2002::/16", // deprecated 6to4

  // reserved
  "100::/64", // discard
  "ff00::/8", // multicast
  "2001:db8::/32", // documentation
];

const blocked = new BlockList();

function blockRanges(cidrs: readonly string[], family: "ipv4" | "ipv6"): void {
  for (const cidr of cidrs) {
    const [network, prefix] = cidr.split("/");
    // A typo in a security table must fail at import, not quietly widen the guard.
    if (!network || !prefix)
      throw new Error(`malformed CIDR "${cidr}" in the ${family} table`);
    blocked.addSubnet(network, Number(prefix), family);
  }
}

blockRanges(BLOCKED_IPV4, "ipv4");
blockRanges(BLOCKED_IPV6, "ipv6");

/**
 * Whether an address must not be connected to. Unparseable input counts as private, so the
 * guard has to prove an address is safe rather than assume it.
 *
 * NAT64 and 6to4 ranges are refused whole rather than unwrapped to the IPv4 address they
 * embed, so this tool cannot reach IPv4-only sites from a NAT64-only network.
 */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return true;
  return blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}
