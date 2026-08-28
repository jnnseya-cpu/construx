import { createHash, createHmac } from 'node:crypto';
import { DomainError } from '../core/errors.ts';

/**
 * S3-compatible object storage, signed with SigV4, no dependencies.
 *
 * The evidence store holds real files behind their content hashes and it holds
 * them on a volume. That is correct for one instance and it is the reason the
 * application tier cannot be replicated: two containers on separate volumes
 * would each hold half the evidence, and a request routed to the wrong one would
 * answer "the platform holds the hash of this evidence but not the file" about a
 * file the platform certainly holds.
 *
 * This is the adapter that moves the bytes somewhere both containers can reach.
 * S3's API is the one every object store implements — R2, MinIO, Backblaze,
 * Ceph — so writing to it once reaches all of them, and the region and endpoint
 * are configuration rather than a rewrite.
 *
 * ## Why sign it by hand
 *
 * Zero runtime dependencies is settled, so the AWS SDK is not available. SigV4
 * is a documented HMAC chain over a canonical request; it is fiddly rather than
 * hard, and every part of the fiddliness is testable — which is why
 * `tests/s3.test.ts` checks the signer against **AWS's own published test
 * vector** rather than against itself.
 *
 * ## What is never done here
 *
 * No retry loop. A failed upload is refused to the caller, and the caller's
 * response is to refuse the ingestion — because the alternative is recording a
 * hash as held when the bytes did not arrive, and an evidence register listing
 * a file nobody can produce is worse than one that refused it.
 */

export type S3Options = {
  /** e.g. `https://s3.eu-west-2.amazonaws.com` or an R2 / MinIO endpoint. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Path-style puts the bucket in the path; virtual-hosted puts it in the host.
   * MinIO and most self-hosted stores need path style; AWS prefers virtual.
   */
  pathStyle: boolean;
  timeoutMs: number;
};

const UNSIGNED_PAYLOAD_HASH = createHash('sha256').update('').digest('hex');

/**
 * Percent-encode for a canonical request.
 *
 * `encodeURIComponent` leaves `!'()*` alone and AWS requires them encoded, and
 * it encodes `~` which AWS requires left alone. Both differences produce a
 * signature mismatch that reads as "the security token is invalid" — an error
 * about credentials, for a bug about punctuation.
 */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const char of value) {
    if (/[A-Za-z0-9\-._~]/.test(char)) {
      out += char;
    } else if (char === '/') {
      out += encodeSlash ? '%2F' : '/';
    } else {
      for (const byte of Buffer.from(char, 'utf8')) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

export type SignedRequest = { url: string; headers: Record<string, string> };

/**
 * Sign one request with Signature Version 4.
 *
 * Split out and exported so it can be checked against AWS's published vector
 * without a socket. The steps, in the order the specification gives them:
 *
 *   1. canonical request  — method, path, query, headers, signed-header list,
 *      payload hash
 *   2. string to sign     — algorithm, timestamp, credential scope, hash of (1)
 *   3. signing key        — HMAC chain: secret → date → region → service → term
 *   4. Authorization      — credential, signed headers, signature
 *
 * The two details that catch people: S3 does **not** double-encode the path the
 * way other services do, and `x-amz-content-sha256` is required rather than
 * optional — an S3 request without it is rejected however correct the signature.
 */
export function sign(
  options: {
    method: string;
    url: URL;
    headers: Record<string, string>;
    payloadHash: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    service?: string;
  },
  now = new Date(),
): SignedRequest {
  const service = options.service ?? 's3';
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, '')}`;
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    ...options.headers,
    host: options.url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': options.payloadHash,
  };

  const sortedNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = sortedNames
    .map((name) => {
      const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? '';
      // Sequential whitespace collapses, and leading/trailing goes. A header
      // signed with the spacing the caller happened to use will not verify.
      return `${name}:${String(value).trim().replace(/\s+/g, ' ')}\n`;
    })
    .join('');
  const signedHeaders = sortedNames.join(';');

  // The query string must be sorted by key, with both key and value encoded.
  const query = [...options.url.searchParams.entries()]
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const canonicalRequest = [
    options.method,
    // S3 signs the path once. Every other AWS service encodes it twice, and
    // applying that rule here produces a mismatch on any key with a slash in it
    // — which is every key this store writes, because they are fanned out.
    uriEncode(decodeURIComponent(options.url.pathname), false),
    query,
    canonicalHeaders,
    signedHeaders,
    options.payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${options.region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${options.secretAccessKey}`, dateStamp), options.region), service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    url: options.url.toString(),
    headers: {
      ...headers,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/**
 * Raised when the object store cannot be reached or refuses.
 *
 * A `DomainError` at 503 rather than a plain `Error`, so the gateway answers
 * "the object store is unavailable" rather than "the request could not be
 * completed" — the same lesson the antivirus client learned by shipping the
 * wrong one and watching an operator get a 500 about a scanner.
 */
export class ObjectStoreError extends DomainError {
  constructor(message: string, status = 503) {
    super('OBJECT_STORE_UNAVAILABLE', message, status);
    this.name = 'ObjectStoreError';
  }
}

export class S3Client {
  readonly #options: S3Options;

  constructor(options: S3Options) {
    this.#options = options;
  }

  get configured(): boolean {
    return (
      this.#options.endpoint !== '' &&
      this.#options.bucket !== '' &&
      this.#options.accessKeyId !== '' &&
      this.#options.secretAccessKey !== ''
    );
  }

  /** Where this deployment is writing, with no credential in it. */
  get address(): string {
    return this.configured ? `${this.#options.endpoint}/${this.#options.bucket}` : 'not configured';
  }

  #url(key: string): URL {
    const base = new URL(this.#options.endpoint);
    // Each segment encoded separately, so a slash in the key stays a path
    // separator and everything else is escaped.
    const encoded = key.split('/').map((segment) => uriEncode(segment)).join('/');
    if (this.#options.pathStyle) {
      base.pathname = `/${this.#options.bucket}/${encoded}`;
    } else {
      base.host = `${this.#options.bucket}.${base.host}`;
      base.pathname = `/${encoded}`;
    }
    return base;
  }

  async #send(
    method: string,
    key: string,
    body?: Buffer,
    extraHeaders: Record<string, string> = {},
    query: Record<string, string> = {},
  ): Promise<Response> {
    if (!this.configured) {
      throw new ObjectStoreError('No object store is configured on this deployment.');
    }

    const url = this.#url(key);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);

    const payloadHash = body ? createHash('sha256').update(body).digest('hex') : UNSIGNED_PAYLOAD_HASH;
    const signed = sign({
      method,
      url,
      headers: extraHeaders,
      payloadHash,
      accessKeyId: this.#options.accessKeyId,
      secretAccessKey: this.#options.secretAccessKey,
      region: this.#options.region,
    });

    try {
      return await fetch(signed.url, {
        method,
        headers: signed.headers,
        body,
        signal: AbortSignal.timeout(this.#options.timeoutMs),
      });
    } catch (error) {
      throw new ObjectStoreError(
        `${this.address} did not answer: ${error instanceof Error ? error.message : String(error)}. ` +
          'Nothing has been recorded against this file.',
      );
    }
  }

  /**
   * Write an object.
   *
   * The content hash travels as `Content-MD5`'s stronger cousin — the SigV4
   * payload hash — so a body corrupted in flight fails the signature rather than
   * being stored as a valid object with the wrong bytes. That is the property
   * the whole evidence chain rests on.
   */
  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const response = await this.#send('PUT', key, bytes, {
      'content-type': contentType,
      'content-length': String(bytes.length),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ObjectStoreError(
        `${this.address} refused the upload with ${response.status}: ${detail.slice(0, 200)}. ` +
          'The file is not held, and nothing has been recorded as holding it.',
      );
    }
    // Drain, so the connection is reusable rather than left half-read.
    await response.arrayBuffer().catch(() => undefined);
  }

  /** Read an object. `undefined` where it is genuinely absent, rather than an error. */
  async get(key: string): Promise<{ bytes: Buffer; contentType: string } | undefined> {
    const response = await this.#send('GET', key);
    if (response.status === 404) return undefined;
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new ObjectStoreError(`${this.address} answered ${response.status} for a read: ${detail.slice(0, 200)}`);
    }
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  /**
   * Whether an object is there, without moving its bytes.
   *
   * `false` means absent. An unreachable store **throws** rather than answering
   * false, because "not held" and "cannot tell" are different facts and
   * conflating them is how an evidence register reports a missing file during an
   * outage and somebody re-uploads it.
   */
  async has(key: string): Promise<boolean> {
    const response = await this.#send('HEAD', key);
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new ObjectStoreError(`${this.address} answered ${response.status} for a HEAD; it cannot say whether this file is held.`);
    }
    return true;
  }

  async delete(key: string): Promise<void> {
    const response = await this.#send('DELETE', key);
    // S3 answers 204 for a delete, and 204 for deleting something absent.
    if (!response.ok && response.status !== 404) {
      throw new ObjectStoreError(`${this.address} answered ${response.status} for a delete`);
    }
    await response.arrayBuffer().catch(() => undefined);
  }

  /**
   * Keys under a prefix.
   *
   * Paginated with a continuation token: a bucket holding a large tenancy's
   * evidence returns a truncated first page, and a caller that ignored the
   * truncation flag would silently report a fraction of what is held.
   */
  async list(prefix: string): Promise<Array<{ key: string; size: number }>> {
    const found: Array<{ key: string; size: number }> = [];
    let token: string | undefined;

    do {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (token) query['continuation-token'] = token;

      const response = await this.#send('GET', '', undefined, {}, query);
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new ObjectStoreError(`${this.address} answered ${response.status} for a listing: ${detail.slice(0, 200)}`);
      }
      const xml = await response.text();
      found.push(...parseListing(xml));
      token = truncated(xml) ? nextToken(xml) : undefined;
    } while (token);

    return found;
  }

  /** Reachable and authorised, without writing anything. */
  async reachable(): Promise<{ reachable: boolean; reason?: string }> {
    if (!this.configured) return { reachable: false, reason: 'No object store is configured on this deployment.' };
    try {
      const response = await this.#send('GET', '', undefined, {}, { 'list-type': '2', 'max-keys': '0' });
      if (response.ok) return { reachable: true };
      const detail = await response.text().catch(() => '');
      return { reachable: false, reason: `answered ${response.status}: ${detail.slice(0, 160)}` };
    } catch (error) {
      return { reachable: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

/**
 * Read an S3 listing without an XML parser.
 *
 * The response is a fixed, documented shape and the only fields wanted are the
 * key and the size. A general XML parser would be a dependency, and writing one
 * would be building a parser to read four tags.
 */
export function parseListing(xml: string): Array<{ key: string; size: number }> {
  const found: Array<{ key: string; size: number }> = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = match[1] ?? '';
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(body)?.[1];
    if (key) found.push({ key: decodeEntities(key), size: Number(size ?? 0) });
  }
  return found;
}

export function truncated(xml: string): boolean {
  return /<IsTruncated>true<\/IsTruncated>/i.test(xml);
}

export function nextToken(xml: string): string | undefined {
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return token ? decodeEntities(token) : undefined;
}

/** The five XML entities. A key containing an ampersand arrives escaped. */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
