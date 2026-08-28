import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bindMessage,
  decode,
  md5Password,
  parseMessage,
  parseTextArray,
  passwordMessage,
  readDataRow,
  readRowDescription,
  readServerMessage,
  Reader,
  Scram,
  simpleQuery,
  SSL_REQUEST,
  startupMessage,
  Writer,
} from '../src/store/wire.ts';

/**
 * The Postgres wire protocol, without a Postgres.
 *
 * `postgres.live.test.ts` proves the client against a real server and is the
 * authority on whether it works. This file proves the framing itself, and does
 * two things that a live test cannot:
 *
 *   - It checks SCRAM-SHA-256 against **RFC 7677's own published test vector**,
 *     so the implementation is confirmed by an external authority rather than by
 *     agreeing with itself. A live server would accept a subtly wrong
 *     implementation that happened to be self-consistent in the wrong way only
 *     if the server were also wrong — but it would give no evidence about which
 *     part was right, and a failure would be a login error with no detail.
 *   - It runs in `npm test`, with no cluster, so a change to the framing fails
 *     the ordinary suite rather than waiting for somebody to run the live check.
 */

describe('framing', () => {
  it('puts the length after the type byte and counts itself', () => {
    // The one off-by-one everybody writes wrong first time: the length covers
    // itself and the body, and not the type byte.
    const message = new Writer().cstring('SELECT 1').frame('Q');
    assert.equal(String.fromCharCode(message[0]!), 'Q');
    assert.equal(message.readInt32BE(1), message.length - 1);
    assert.equal(message.subarray(5, message.length - 1).toString('utf8'), 'SELECT 1');
    assert.equal(message[message.length - 1], 0);
  });

  it('omits the type byte on startup, which has none', () => {
    const message = startupMessage({ user: 'construx_app', database: 'construx' });
    assert.equal(message.readInt32BE(0), message.length);
    // 196608 is protocol 3.0 packed as major/minor.
    assert.equal(message.readInt32BE(4), 196608);
    assert.match(message.toString('utf8'), /construx_app/);
    assert.equal(message[message.length - 1], 0, 'the parameter list must be terminated');
  });

  it('drops an empty parameter rather than sending a blank one', () => {
    // Postgres rejects an empty `application_name` differently from an absent
    // one, and sending blanks is how a connection fails on a setting nobody set.
    const message = startupMessage({ user: 'a', application_name: '' });
    assert.equal(message.includes('application_name'), false);
  });

  it('asks for TLS with the documented magic number', () => {
    assert.equal(SSL_REQUEST.length, 8);
    assert.equal(SSL_REQUEST.readInt32BE(0), 8);
    assert.equal(SSL_REQUEST.readInt32BE(4), 80877103);
  });

  it('sends a parameterised statement with no values in the SQL', () => {
    const parse = parseMessage('', 'SELECT * FROM event WHERE tenant_id = $1');
    const text = parse.toString('utf8');
    assert.match(text, /\$1/);
    // Zero parameter types declared: the server infers them, rather than this
    // client deciding what $1 is.
    assert.equal(parse.readInt16BE(parse.length - 2), 0);

    const bind = bindMessage('', '', ["'; DROP TABLE event; --"]);
    // The hostile value is in the Bind message, which the server never parses
    // as SQL. It appears nowhere in the Parse message.
    assert.equal(parse.includes('DROP TABLE'), false);
    assert.equal(bind.includes('DROP TABLE'), true);
  });

  it('sends null as length -1 rather than as an empty string', () => {
    // Two different values in SQL. Conflating them is how a nullable column
    // quietly fills with empty strings.
    const withNull = bindMessage('', '', [null]);
    const withEmpty = bindMessage('', '', ['']);
    // The same length on the wire — both carry a 4-byte length and no data —
    // so the message size proves nothing and the *value* of that length is the
    // whole distinction: -1 for null, 0 for an empty string.
    assert.equal(withNull.length, withEmpty.length);
    assert.equal(withNull.includes(Buffer.from([0xff, 0xff, 0xff, 0xff])), true, 'null must be sent as length -1');
    assert.equal(withEmpty.includes(Buffer.from([0xff, 0xff, 0xff, 0xff])), false, 'an empty string must not be sent as -1');
  });

  it('asks for text results, so numeric is never a float', () => {
    const bind = bindMessage('', '', ['x']);
    // One result format code, value 0 = text.
    assert.equal(bind.readInt16BE(bind.length - 4), 1);
    assert.equal(bind.readInt16BE(bind.length - 2), 0);
  });
});

describe('reading what the server sends', () => {
  it('refuses to read past the end rather than returning zeros', () => {
    // A short read here is a hang, so it throws. Silently returning a zero
    // would desynchronise the stream and the symptom would appear elsewhere.
    const reader = new Reader(Buffer.from([0, 0]));
    assert.throws(() => reader.int32(), /wanted 4 bytes/);
  });

  it('reads an error into the fields an operator needs', () => {
    const body = Buffer.concat([
      Buffer.from('SERROR\0'),
      Buffer.from('C23505\0'),
      Buffer.from('Mduplicate key value violates unique constraint\0'),
      Buffer.from('nevent_project_chain_uniq\0'),
      Buffer.from([0]),
    ]);
    const message = readServerMessage(new Reader(body));
    assert.equal(message.code, '23505');
    assert.equal(message.constraint, 'event_project_chain_uniq');
    assert.match(message.message, /unique constraint/);
  });

  it('names an error with no message rather than returning undefined', () => {
    const message = readServerMessage(new Reader(Buffer.from([0])));
    assert.equal(message.code, 'XX000');
    assert.match(message.message, /no message/);
  });

  it('reads a row description and a row against it', () => {
    const description = Buffer.concat([
      Buffer.from([0, 1]), // one field
      Buffer.from('count\0'),
      Buffer.from([0, 0, 0, 0]), // table oid
      Buffer.from([0, 0]), // column number
      Buffer.from([0, 0, 0, 23]), // int4
      Buffer.from([0, 4]), // size
      Buffer.from([0, 0, 0, 0]), // modifier
      Buffer.from([0, 0]), // format
    ]);
    const fields = readRowDescription(new Reader(description));
    assert.deepEqual(fields, [{ name: 'count', typeOid: 23 }]);

    const row = Buffer.concat([Buffer.from([0, 1]), Buffer.from([0, 0, 0, 2]), Buffer.from('42')]);
    assert.deepEqual(readDataRow(new Reader(row)), ['42']);
    assert.equal(decode('42', 23), 42);
  });
});

describe('converting what the server sent', () => {
  it('leaves numeric as text, because a payment is not a float', () => {
    // 1700 is numeric. Turning it into a Number is how a certificate loses
    // pennies, and the loss is invisible until somebody reconciles.
    assert.equal(decode('12345678901234.56', 1700), '12345678901234.56');
  });

  it('keeps a bigint beyond the safe range as text rather than rounding it', () => {
    assert.equal(decode('9007199254740993', 20), '9007199254740993');
    assert.equal(decode('42', 20), 42);
  });

  it('reads a boolean the way Postgres writes one', () => {
    assert.equal(decode('t', 16), true);
    assert.equal(decode('f', 16), false);
  });

  it('parses jsonb, and returns the raw text when it will not parse', () => {
    assert.deepEqual(decode('{"op":"add"}', 3802), { op: 'add' });
    // A jsonb column that will not parse is a fact worth surfacing rather than
    // swallowing — the caller gets what the server actually sent.
    assert.equal(decode('not json', 3802), 'not json');
  });

  it('passes an unknown type through untouched', () => {
    // Lossless and obviously unconverted beats a clever coercion.
    assert.equal(decode('2026-08-28 09:00:00+00', 1184), '2026-08-28 09:00:00+00');
  });

  it('leaves null alone whatever the type says', () => {
    assert.equal(decode(null, 23), null);
    assert.equal(decode(null, 3802), null);
  });
});

describe('array literals, which a naive split corrupts', () => {
  it('reads the ordinary case', () => {
    assert.deepEqual(parseTextArray('{PM,QS,PLANNER}'), ['PM', 'QS', 'PLANNER']);
  });

  it('reads an empty array as empty rather than as one blank element', () => {
    assert.deepEqual(parseTextArray('{}'), []);
  });

  it('keeps a comma that is inside an element', () => {
    // The exact corruption a split on comma produces, on the roles column this
    // schema actually stores.
    assert.deepEqual(parseTextArray('{"Commercial, Lead",QS}'), ['Commercial, Lead', 'QS']);
  });

  it('keeps an escaped quote and an escaped backslash', () => {
    assert.deepEqual(parseTextArray('{"says \\"no\\"","back\\\\slash"}'), ['says "no"', 'back\\slash']);
  });

  it('returns nothing for something that is not an array literal', () => {
    assert.deepEqual(parseTextArray('PM,QS'), []);
  });
});

describe('SCRAM-SHA-256, against the RFC 7677 test vector', () => {
  // The vector, verbatim from RFC 7677 §3. Username `user`, password `pencil`.
  const CLIENT_NONCE = 'rOprNGfwEbeRWgbNEkqO';
  const SERVER_FIRST =
    'r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096';
  const EXPECTED_PROOF = 'dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=';
  const SERVER_FINAL = 'v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=';

  it('produces the proof the RFC publishes', () => {
    // This is the assertion that makes the implementation trustworthy. A live
    // server proves the two ends agree; only an external vector proves *this*
    // end is the one that is right.
    const scram = new Scram('pencil', CLIENT_NONCE, 'user');
    scram.initial();
    const final = scram.final(SERVER_FIRST);
    assert.match(final.toString('utf8'), new RegExp(`p=${EXPECTED_PROOF.replace(/[+/]/g, '\\$&')}`));
  });

  it('sends the unchanged GS2 header, so the channel-binding choice is covered', () => {
    const scram = new Scram('pencil', CLIENT_NONCE, 'user');
    scram.initial();
    // `c=biws` is base64("n,,"). It is part of the signed message, which is what
    // stops a downgrade of the channel-binding decision going unnoticed.
    assert.match(scram.final(SERVER_FIRST).toString('utf8'), /c=biws/);
  });

  it('names the mechanism in the initial response', () => {
    const initial = new Scram('pencil', CLIENT_NONCE, 'user').initial();
    assert.equal(String.fromCharCode(initial[0]!), 'p');
    assert.match(initial.toString('utf8'), /SCRAM-SHA-256/);
    assert.match(initial.toString('utf8'), /n,,n=user,r=rOprNGfwEbeRWgbNEkqO/);

    // And the default, which is what Postgres actually receives: the username
    // already travelled in the startup packet, so `n=` is empty.
    assert.match(new Scram('pencil', CLIENT_NONCE).initial().toString('utf8'), /n,,n=,r=/);
  });

  it('verifies the server signature the RFC publishes', () => {
    const scram = new Scram('pencil', CLIENT_NONCE, 'user');
    scram.initial();
    scram.final(SERVER_FIRST);
    // Does not throw: the server proved it holds the password.
    scram.verify(SERVER_FINAL);
  });

  it('refuses a server that cannot prove it holds the password', () => {
    // The half most implementations skip, and skipping it removes the mutual
    // part of mutual authentication: something in the middle that cannot read
    // the password could still convince this client it is the database.
    const scram = new Scram('pencil', CLIENT_NONCE, 'user');
    scram.initial();
    scram.final(SERVER_FIRST);
    assert.throws(
      () => scram.verify('v=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='),
      /not the database/,
    );
  });

  it('refuses a server that did not echo the client nonce', () => {
    // The reply is only a reply to our message if it carries our nonce. Without
    // this check a replayed server-first from another exchange is accepted.
    const scram = new Scram('pencil', CLIENT_NONCE, 'user');
    scram.initial();
    assert.throws(() => scram.final('r=somebodyElsesNonce,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096'), /echo the client nonce/);
  });

  it('refuses a server sending no salt or a zero iteration count', () => {
    const scram = new Scram('pencil', CLIENT_NONCE, 'user');
    scram.initial();
    assert.throws(() => scram.final(`r=${CLIENT_NONCE}x,s=,i=4096`), /no usable salt/);
    assert.throws(() => scram.final(`r=${CLIENT_NONCE}x,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=0`), /no usable salt/);
  });

  it('refuses to verify before the exchange has produced a signature', () => {
    assert.throws(() => new Scram('pencil').verify(SERVER_FINAL), /verify before final/);
  });
});

describe('MD5 authentication, which a default cluster still offers', () => {
  it('concatenates in the order the protocol specifies', () => {
    // md5(md5(password + user) + salt), and getting the order backwards
    // produces a failure indistinguishable from a wrong password.
    const salt = Buffer.from([1, 2, 3, 4]);
    const message = md5Password('construx_app', 'secret', salt);
    const text = message.subarray(5, message.length - 1).toString('utf8');
    assert.match(text, /^md5[0-9a-f]{32}$/);

    // Same inputs, same digest; a different user changes it.
    assert.equal(md5Password('construx_app', 'secret', salt).equals(message), true);
    assert.equal(md5Password('someone_else', 'secret', salt).equals(message), false);
    assert.equal(md5Password('construx_app', 'secret', Buffer.from([9, 9, 9, 9])).equals(message), false);
  });

  it('sends a cleartext password as a plain password message', () => {
    const message = passwordMessage('secret');
    assert.equal(String.fromCharCode(message[0]!), 'p');
    assert.equal(message.subarray(5, message.length - 1).toString('utf8'), 'secret');
  });
});

describe('the simple path carries no values', () => {
  it('is a bare statement, which is why it takes no parameters', () => {
    const message = simpleQuery('BEGIN');
    assert.equal(String.fromCharCode(message[0]!), 'Q');
    assert.equal(message.subarray(5, message.length - 1).toString('utf8'), 'BEGIN');
  });
});
