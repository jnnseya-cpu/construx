import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addressBytes, clientAddress, isTrustedProxy, parseTrustedProxies } from '../src/api/clientaddress.ts';

/**
 * Who a request is from, for rate limiting.
 *
 * The defect: buckets were keyed on `req.socket.remoteAddress`, which behind a
 * reverse proxy is the proxy for every request in the world. The 1,000/minute
 * anonymous budget became one global bucket that any single client could
 * exhaust for everybody, and the 20/minute login budget — which exists to stop
 * credential stuffing against *one* address — became a global cap, so an
 * attacker running a list also locked out every legitimate customer.
 *
 * The naive fix is worse than the defect, and most of this file is about that.
 * Believing `X-Forwarded-For` from anywhere hands the bucket key to the
 * attacker: set a header, get a private bucket per forged value, have no limit
 * at all. So the header is believed only from a named range, the default list
 * is empty, and the chain is read from the right.
 */

const PROXY = parseTrustedProxies('10.0.0.0/8, 192.168.1.1').blocks;
const NONE = parseTrustedProxies('').blocks;

describe('parsing an address', () => {
  it('reads IPv4', () => {
    assert.deepEqual([...addressBytes('203.0.113.7')!], [203, 0, 113, 7]);
  });

  it('normalises the IPv4-mapped IPv6 form Node reports on a dual-stack listener', () => {
    // `::ffff:10.0.0.1` is how an IPv4 client arrives on a socket bound to ::,
    // and an operator writing `10.0.0.0/8` means that address. Treating the two
    // as different families is how a correctly configured proxy stops being
    // trusted the day somebody enables IPv6.
    assert.deepEqual([...addressBytes('::ffff:10.0.0.1')!], [10, 0, 0, 1]);
    assert.ok(isTrustedProxy('::ffff:10.0.0.1', PROXY));
  });

  it('reads IPv6, including the :: run', () => {
    assert.equal(addressBytes('2001:db8::1')?.length, 16);
    assert.equal(addressBytes('::1')?.length, 16);
    assert.equal(addressBytes('fe80::1%eth0')?.length, 16, 'a zone index names an interface, not the address');
  });

  it('refuses nonsense rather than producing bytes for it', () => {
    for (const bad of ['', 'not-an-address', '999.1.1.1', '1.2.3', '::gg', '1:2:3::4::5']) {
      assert.equal(addressBytes(bad), undefined, `${bad} parsed as an address`);
    }
  });
});

describe('parsing the configured ranges', () => {
  it('reads a mixed list', () => {
    const { blocks, rejected } = parseTrustedProxies('10.0.0.0/8, 172.16.0.0/12,2001:db8::/32');
    assert.equal(blocks.length, 3);
    assert.deepEqual(rejected, []);
  });

  it('treats a bare address as itself alone', () => {
    const { blocks } = parseTrustedProxies('192.168.1.1');
    assert.ok(isTrustedProxy('192.168.1.1', blocks));
    assert.ok(!isTrustedProxy('192.168.1.2', blocks), 'a bare address must not widen to its subnet');
  });

  it('drops a malformed entry rather than throwing, and says which', () => {
    // This parses on the request path. A typo in one range must not take the
    // gateway down — but it must not vanish either, or "I set it and nothing
    // happened" is unanswerable.
    const { blocks, rejected } = parseTrustedProxies('10.0.0.0/8, nonsense, 1.2.3.4/99');
    assert.equal(blocks.length, 1);
    assert.deepEqual(rejected, ['nonsense', '1.2.3.4/99']);
  });

  it('does not let a prefix length wider than the family through', () => {
    assert.deepEqual(parseTrustedProxies('10.0.0.0/33').rejected, ['10.0.0.0/33']);
    assert.deepEqual(parseTrustedProxies('2001:db8::/129').rejected, ['2001:db8::/129']);
  });

  it('matches on the bits that are significant, not on whole bytes', () => {
    // A /12 splits a byte. Getting this wrong is the kind of error that makes a
    // range look right in a test written with /8 and /16 and be wrong in
    // production, where 172.16.0.0/12 is the common one.
    const { blocks } = parseTrustedProxies('172.16.0.0/12');
    assert.ok(isTrustedProxy('172.16.0.1', blocks));
    assert.ok(isTrustedProxy('172.31.255.254', blocks));
    assert.ok(!isTrustedProxy('172.32.0.1', blocks), '172.32.0.1 is outside a /12 starting at 172.16');
    assert.ok(!isTrustedProxy('172.15.255.254', blocks));
  });

  it('never matches one family against the other', () => {
    const { blocks } = parseTrustedProxies('::/0');
    assert.ok(!isTrustedProxy('10.0.0.1', blocks), 'an IPv6 default route must not swallow every IPv4 address');
  });
});

describe('choosing the address to rate limit on', () => {
  it('uses the socket address when no proxy is configured, which is the default', () => {
    // The whole safety of this file. A deployment that configures nothing
    // behaves exactly as it did before the file existed.
    assert.equal(clientAddress('203.0.113.7', '1.2.3.4', NONE), '203.0.113.7');
  });

  it('ignores the header when the connection did not come from a trusted proxy', () => {
    // The attack: reach the process directly, set a header, claim to be
    // somebody else and get your own bucket. Refused.
    assert.equal(clientAddress('203.0.113.7', '10.0.0.5', PROXY), '203.0.113.7');
  });

  it('uses the forwarded address when the connection did come from a trusted proxy', () => {
    assert.equal(clientAddress('10.0.0.5', '203.0.113.7', PROXY), '203.0.113.7');
  });

  it('reads the chain from the right, because the left is what a client can write', () => {
    // `X-Forwarded-For: <forged>, <real client>, <inner proxy>`. A client can
    // put anything at the left; only the entries added by the operator's own
    // equipment are on the right. Reading left-to-right takes the forgery,
    // which is the single commonest way this control is implemented wrongly.
    assert.equal(clientAddress('10.0.0.5', '1.1.1.1, 203.0.113.7, 10.0.0.9', PROXY), '203.0.113.7');
  });

  it('cannot be defeated by prepending a trusted-looking address', () => {
    // The attacker knows the internal range and writes it at the left, hoping
    // the parser skips their real address as "a proxy". Walking from the right
    // reaches their real address first.
    assert.equal(clientAddress('10.0.0.5', '10.0.0.1, 10.0.0.2, 203.0.113.7', PROXY), '203.0.113.7');
  });

  it('falls back to the socket when every hop is a trusted proxy', () => {
    // Health checks and internal traffic look like this. Inventing a client
    // from a chain that contains none would be a guess.
    assert.equal(clientAddress('10.0.0.5', '10.0.0.1, 10.0.0.2', PROXY), '10.0.0.5');
  });

  it('falls back to the socket when the header is unparseable', () => {
    assert.equal(clientAddress('10.0.0.5', 'not-an-address, also-not', PROXY), '10.0.0.5');
    assert.equal(clientAddress('10.0.0.5', '', PROXY), '10.0.0.5');
  });

  it('strips a port from an IPv4 entry, which some proxies append', () => {
    assert.equal(clientAddress('10.0.0.5', '203.0.113.7:41234', PROXY), '203.0.113.7');
  });

  it('normalises an entry to one spelling, because this becomes a bucket key', () => {
    // `[2001:db8::1]` and `2001:db8::1` are the same client. Returning them
    // verbatim gives that client two budgets — the very defect this closes,
    // reintroduced one layer down. Caught by the test failing on the first run.
    assert.equal(clientAddress('10.0.0.5', '[2001:db8::1]', PROXY), '2001:db8::1');
    assert.equal(
      clientAddress('10.0.0.5', '[2001:db8::1]', PROXY),
      clientAddress('10.0.0.5', '2001:db8::1', PROXY),
      'two spellings of one address must key the same bucket',
    );
    assert.equal(clientAddress('10.0.0.5', 'fe80::1%eth0', PROXY), 'fe80::1', 'a zone index is not part of the address');
  });

  it('answers something usable when the socket address is missing entirely', () => {
    assert.equal(clientAddress(undefined, undefined, PROXY), 'unknown');
  });

  it('gives two clients behind one proxy two different keys, which is the point', () => {
    const a = clientAddress('10.0.0.5', '203.0.113.7', PROXY);
    const b = clientAddress('10.0.0.5', '198.51.100.4', PROXY);
    assert.notEqual(a, b, 'behind a proxy, one client exhausting the budget would deny service to everybody');
  });
});
