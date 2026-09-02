import { config } from '../config.ts';

/**
 * Who a request is *from*, for the purpose of rate limiting.
 *
 * ## The defect this closes
 *
 * Rate-limit buckets were keyed on `req.socket.remoteAddress`. On a machine
 * with nothing in front of it that is the client. Behind a reverse proxy — and
 * `deploy/compose.edge.yaml` puts one there — it is the proxy, for every
 * request in the world. So:
 *
 *   - the 1,000/minute anonymous budget became a single global bucket, and one
 *     client could exhaust it for everybody, which is a denial of service that
 *     needs no skill and leaves no trace beyond a 429 for innocent people;
 *   - the 20/minute login budget, which exists to stop credential stuffing
 *     against *one* address, became a global cap — so an attacker running a
 *     list also locked out every legitimate customer trying to sign in.
 *
 * ## Why the naive fix is worse than the defect
 *
 * "Read `X-Forwarded-For`" hands the key to the attacker. Anyone who can reach
 * the process sets a header, gets their own private bucket per forged value,
 * and has no limit at all. A rate limiter keyed on an attacker-controlled
 * string is not a rate limiter.
 *
 * So the header is believed **only** when the connection came from an address
 * the operator has named, and the default list is empty — meaning the default
 * behaviour is exactly what it was before this file existed. A deployment has
 * to opt in, by naming the ranges its own proxy speaks from.
 *
 * ## Which entry is the client
 *
 * `X-Forwarded-For` is a chain: `client, proxy1, proxy2`. Each hop appends what
 * it saw, so the entries an attacker controls are at the **left** and the ones
 * added by infrastructure are at the **right**. Reading left-to-right takes the
 * first value the client wrote, which is the forgery.
 *
 * This walks from the right, skipping addresses that are themselves trusted
 * proxies, and takes the first one that is not: the address the outermost
 * *untrusted* hop was seen at. That is the furthest-left entry that any
 * equipment under the operator's control actually witnessed, and it is the
 * standard construction.
 *
 * ## What this is not for
 *
 * Rate limiting and telemetry only. Nothing authorises on it, nothing bills on
 * it, and no permission is decided by it — a header is not evidence of identity
 * whatever it says, and `TRUSTED_PROXY_CIDRS` being right is an operator's
 * configuration rather than a proof.
 */

/** A parsed CIDR block: the network bytes and how many bits are significant. */
type Block = { bytes: Uint8Array; bits: number };

/**
 * Parse an address into its bytes.
 *
 * IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is normalised to the four IPv4 bytes,
 * because that is how Node reports an IPv4 client on a dual-stack listener and
 * an operator writing `10.0.0.0/8` means that address.
 */
export function addressBytes(address: string): Uint8Array | undefined {
  const trimmed = address.trim().replace(/^\[|\]$/g, '');
  if (trimmed === '') return undefined;

  // A zone index (`fe80::1%eth0`) names an interface, not part of the address.
  const withoutZone = trimmed.split('%')[0] ?? '';

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(withoutZone);
  const candidate = mapped ? mapped[1]! : withoutZone;

  if (/^\d+\.\d+\.\d+\.\d+$/.test(candidate)) {
    const parts = candidate.split('.').map(Number);
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
    return Uint8Array.from(parts);
  }

  if (!candidate.includes(':')) return undefined;
  return ipv6Bytes(candidate);
}

/** IPv6 to sixteen bytes, handling the `::` run and a trailing IPv4 tail. */
function ipv6Bytes(address: string): Uint8Array | undefined {
  // At most one `::`.
  const halves = address.split('::');
  if (halves.length > 2) return undefined;

  const expand = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = expand(halves[0] ?? '');
  const tail = halves.length === 2 ? expand(halves[1] ?? '') : [];

  // A trailing IPv4 tail (`::ffff:192.0.2.1`) occupies two groups.
  const groups: string[] = [];
  const pushGroup = (group: string): boolean => {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(group)) {
      const four = addressBytes(group);
      if (!four || four.length !== 4) return false;
      groups.push(((four[0]! << 8) | four[1]!).toString(16), ((four[2]! << 8) | four[3]!).toString(16));
      return true;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return false;
    groups.push(group);
    return true;
  };

  const headGroups: string[] = [];
  for (const group of head) {
    groups.length = 0;
    if (!pushGroup(group)) return undefined;
    headGroups.push(...groups);
  }
  const tailGroups: string[] = [];
  for (const group of tail) {
    groups.length = 0;
    if (!pushGroup(group)) return undefined;
    tailGroups.push(...groups);
  }

  const missing = 8 - headGroups.length - tailGroups.length;
  if (halves.length === 2) {
    if (missing < 0) return undefined;
  } else if (missing !== 0) {
    return undefined;
  }

  const all = [...headGroups, ...Array.from({ length: Math.max(0, missing) }, () => '0'), ...tailGroups];
  if (all.length !== 8) return undefined;

  const bytes = new Uint8Array(16);
  for (const [index, group] of all.entries()) {
    const value = Number.parseInt(group, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return undefined;
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

/**
 * Parse the configured list once.
 *
 * A malformed entry is dropped rather than throwing: this runs on every
 * request, and a typo in one range must not take the gateway down. It is not
 * silent — `parseTrustedProxies` is exported and `readiness()` reports how many
 * of the configured entries were understood, so "I set it and it did nothing"
 * is answerable.
 */
export function parseTrustedProxies(list: string): { blocks: Block[]; rejected: string[] } {
  const blocks: Block[] = [];
  const rejected: string[] = [];

  for (const raw of list.split(',')) {
    const entry = raw.trim();
    if (entry === '') continue;

    const slash = entry.lastIndexOf('/');
    const addressPart = slash === -1 ? entry : entry.slice(0, slash);
    const bytes = addressBytes(addressPart);
    if (!bytes) {
      rejected.push(entry);
      continue;
    }

    // A bare address is that address alone: /32 for IPv4, /128 for IPv6.
    const maximum = bytes.length * 8;
    const bits = slash === -1 ? maximum : Number(entry.slice(slash + 1));
    if (!Number.isInteger(bits) || bits < 0 || bits > maximum) {
      rejected.push(entry);
      continue;
    }

    blocks.push({ bytes, bits });
  }

  return { blocks, rejected };
}

/** True where `address` falls inside `block`. Families never match each other. */
function inBlock(address: Uint8Array, block: Block): boolean {
  if (address.length !== block.bytes.length) return false;

  const wholeBytes = Math.floor(block.bits / 8);
  for (let i = 0; i < wholeBytes; i += 1) {
    if (address[i] !== block.bytes[i]) return false;
  }

  const remainder = block.bits % 8;
  if (remainder === 0) return true;

  const mask = 0xff << (8 - remainder) & 0xff;
  return (address[wholeBytes]! & mask) === (block.bytes[wholeBytes]! & mask);
}

/**
 * One spelling per address, because this becomes a rate-limit bucket key.
 *
 * Brackets and a zone index are notation rather than address, and two
 * spellings of one client are two budgets for that client.
 */
function canonical(address: string): string {
  return address.trim().replace(/^\[|\]$/g, '').split('%')[0] ?? address;
}

export function isTrustedProxy(address: string, blocks: readonly Block[]): boolean {
  const bytes = addressBytes(address);
  if (!bytes) return false;
  return blocks.some((block) => inBlock(bytes, block));
}

/**
 * The address to key a rate-limit bucket on.
 *
 * `socketAddress` is what the kernel saw and is the only thing here that cannot
 * be forged. It is returned unchanged unless *it* is a configured proxy — so a
 * deployment with no configured proxies, which is the default, behaves exactly
 * as it did before this function existed.
 */
export function clientAddress(
  socketAddress: string | undefined,
  forwardedFor: string | undefined,
  blocks: readonly Block[] = trustedProxyBlocks(),
): string {
  const socket = socketAddress ?? 'unknown';
  if (blocks.length === 0 || !forwardedFor) return socket;
  if (!isTrustedProxy(socket, blocks)) return socket;

  // Right to left: infrastructure appends on the right, so the rightmost
  // entries are the ones nobody outside could have written. The first entry
  // from that end that is not itself a trusted proxy is the client.
  const chain = forwardedFor.split(',');
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const hop = (chain[i] ?? '').trim();
    if (hop === '') continue;
    // A port may be attached to an IPv4 entry (`203.0.113.7:41234`). An IPv6
    // entry is bracketed when it carries one, and `addressBytes` strips those.
    const withoutPort = /^\d+\.\d+\.\d+\.\d+:\d+$/.test(hop) ? hop.slice(0, hop.lastIndexOf(':')) : hop;
    if (!addressBytes(withoutPort)) continue;
    if (isTrustedProxy(withoutPort, blocks)) continue;
    // Normalised before it becomes a bucket key. `[2001:db8::1]` and
    // `2001:db8::1` are the same client, and returning them verbatim would
    // hand that client two budgets — which is the defect this file exists to
    // close, reintroduced one layer down.
    return canonical(withoutPort);
  }

  // Every hop in the chain is a trusted proxy, or none parsed. The socket
  // address is the honest answer rather than a guess.
  return socket;
}

/**
 * The configured blocks, parsed once per process.
 *
 * Read through a function rather than a module constant so a test can change
 * the environment and re-parse; `reset` is what makes that possible without
 * reloading the module.
 */
let cached: { source: string; parsed: ReturnType<typeof parseTrustedProxies> } | undefined;

export function trustedProxies(): ReturnType<typeof parseTrustedProxies> {
  const source = config.transport.trustedProxyCidrs;
  if (!cached || cached.source !== source) {
    cached = { source, parsed: parseTrustedProxies(source) };
  }
  return cached.parsed;
}

export function trustedProxyBlocks(): readonly Block[] {
  return trustedProxies().blocks;
}
