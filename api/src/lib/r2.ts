import { AwsClient } from 'aws4fetch';
import { env } from './env.js';

// Cloudflare R2 storage.
//
// R2 is S3-compatible, so we sign plain `fetch` requests with aws4fetch (SigV4)
// and talk to the bucket's S3 endpoint directly — no AWS SDK. aws4fetch uses
// only `fetch` + Web Crypto, so the same code runs on Bun (dev/tests) and Node
// (the production container).
//
// Two buckets, one credential:
//   • brand-assets  — PUBLIC-read (workspace logos). Objects are addressed by an
//                     unsigned URL under R2_PUBLIC_BASE_URL.
//   • attachments   — PRIVATE (ticket attachments: customer files, inline email
//                     images). No public URL exists; the API mints short-lived
//                     presigned GET URLs per request. REVIEW-PUNCHLIST §attachments
//                     forbids the public bucket for this data.
//
// Lazy + memoised, mirroring lib/db.ts: importing this module never reads
// credentials or throws, so the API still boots while R2 is unconfigured. The
// client is built on first use; each store method resolves its config when
// called, so holding a store handle is free and a clear error surfaces only on
// the request that actually needs storage.

let _client: AwsClient | null = null;

// R2's S3 API uses a fixed pseudo-region.
const R2_REGION = 'auto';

// Default lifetime of a presigned attachment URL. Long enough for an agent to
// work a ticket in an open tab; short enough that a leaked URL goes stale.
export const PRESIGN_DEFAULT_EXPIRES_SECONDS = 6 * 60 * 60;

// Simultaneous DELETEs in deleteKeys — retention can hand it every attachment
// of a 500-ticket batch, so it must not fan out unbounded.
const DELETE_CONCURRENCY = 16;

// Thrown by deleteKeys after EVERY key was attempted: `failedKeys` is exactly
// the set still in the bucket, so callers can retry/park those alone.
export class R2DeleteError extends Error {
  constructor(public readonly failedKeys: string[]) {
    super(`R2 DELETE failed for ${failedKeys.length} object(s)`);
    this.name = 'R2DeleteError';
  }
}

export interface R2StoreConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export interface PutObjectOptions {
  contentType: string;
  // Stored as object metadata and echoed on every GET. Defaults to a bare
  // `attachment` so direct navigation downloads instead of rendering (audit #7);
  // <img> embeds are unaffected (browsers ignore disposition for subresources).
  contentDisposition?: string;
}

export interface PresignOptions {
  expiresSeconds?: number;
  // Fixed SigV4 timestamp (YYYYMMDDTHHMMSSZ) — for deterministic tests only.
  datetime?: string;
}

export interface R2Store {
  putObject(key: string, bytes: Uint8Array, opts: PutObjectOptions): Promise<void>;
  getObject(key: string): Promise<{ bytes: Uint8Array; contentType: string | null }>;
  listKeys(prefix: string): Promise<string[]>;
  deleteKeys(keys: string[]): Promise<void>;
  presignGet(key: string, opts?: PresignOptions): Promise<string>;
}

function requireCredentials(): Omit<R2StoreConfig, 'bucket'> {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error(
      'Cloudflare R2 is not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and ' +
        'R2_SECRET_ACCESS_KEY in api/.env (see api/.env.example).',
    );
  }
  return { accountId: R2_ACCOUNT_ID, accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY };
}

function clientFor(cfg: R2StoreConfig, shared: boolean): AwsClient {
  if (!shared) {
    return new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: R2_REGION, service: 's3' });
  }
  if (!_client) {
    _client = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: R2_REGION, service: 's3' });
  }
  return _client;
}

// The public-read brand-assets bucket (logos). Same behaviour as before the
// attachments work; `publicUrl()` is the read path.
export function brandAssetsStore(): R2Store {
  return createStore(() => {
    const creds = requireCredentials();
    // The logo path uploads then stores publicUrl(); requiring the public base
    // up front keeps a half-configured deploy from orphaning objects.
    if (!env.R2_PUBLIC_BASE_URL) {
      throw new Error(
        'Cloudflare R2 public base is not configured — set R2_PUBLIC_BASE_URL in api/.env (see api/.env.example).',
      );
    }
    return { ...creds, bucket: env.R2_BUCKET };
  }, true);
}

// The private attachments bucket. Methods throw a clear error until
// R2_ATTACHMENTS_BUCKET is set, so callers can surface "not configured" rather
// than silently writing customer files into the public bucket.
export function attachmentsStore(): R2Store {
  return createStore(() => {
    const creds = requireCredentials();
    if (!env.R2_ATTACHMENTS_BUCKET) {
      throw new Error(
        'Attachment storage is not configured — create a PRIVATE R2 bucket and set ' +
          'R2_ATTACHMENTS_BUCKET in api/.env (see api/.env.example). Never point it at the public brand-assets bucket.',
      );
    }
    return { ...creds, bucket: env.R2_ATTACHMENTS_BUCKET };
  }, true);
}

export function isAttachmentsStorageConfigured(): boolean {
  return Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ATTACHMENTS_BUCKET);
}

// Build a store from an explicit config (tests; one-off scripts). Exported so
// the presign logic can be unit-tested with fixed credentials and no env.
export function createStore(config: R2StoreConfig | (() => R2StoreConfig), sharedClient = false): R2Store {
  const resolve = () => {
    const cfg = typeof config === 'function' ? config() : config;
    return { cfg, client: clientFor(cfg, sharedClient), endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com` };
  };

  return {
    async putObject(key, bytes, opts) {
      const { cfg, client, endpoint } = resolve();
      const res = await client.fetch(objectUrl(endpoint, cfg.bucket, key), {
        method: 'PUT',
        body: bytes,
        headers: {
          'Content-Type': opts.contentType,
          'Content-Disposition': opts.contentDisposition ?? 'attachment',
        },
      });
      if (!res.ok) {
        throw new Error(`R2 PUT ${key} failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
      }
    },

    async getObject(key) {
      const { cfg, client, endpoint } = resolve();
      const res = await client.fetch(objectUrl(endpoint, cfg.bucket, key), { method: 'GET' });
      if (!res.ok) {
        throw new Error(`R2 GET ${key} failed: ${res.status}`);
      }
      return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
    },

    // ListObjectsV2 under a prefix. Returns full keys (including the prefix).
    async listKeys(prefix) {
      const { cfg, client, endpoint } = resolve();
      const url = `${endpoint}/${cfg.bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
      const res = await client.fetch(url, { method: 'GET' });
      if (!res.ok) {
        throw new Error(`R2 LIST ${prefix} failed: ${res.status} ${await res.text().catch(() => '')}`.trim());
      }
      return parseListKeysXml(await res.text());
    },

    // Per-object DELETE (R2 treats DELETE on a missing key as success) with
    // bounded concurrency. Every key is attempted even if an earlier one fails;
    // the failures are reported together as an R2DeleteError so callers can
    // park exactly the keys that are still there. An empty list is a no-op
    // and never touches config.
    async deleteKeys(keys) {
      if (keys.length === 0) return;
      const { cfg, client, endpoint } = resolve();
      const failed: string[] = [];
      for (let i = 0; i < keys.length; i += DELETE_CONCURRENCY) {
        const slice = keys.slice(i, i + DELETE_CONCURRENCY);
        const settled = await Promise.allSettled(
          slice.map(async (key) => {
            // Bounded so a single hung object can't stall the caller indefinitely.
            const res = await client.fetch(objectUrl(endpoint, cfg.bucket, key), {
              method: 'DELETE',
              signal: AbortSignal.timeout(10_000),
            });
            // 204 on delete, 404 if already gone — both are fine.
            if (!res.ok && res.status !== 404) {
              throw new Error(`R2 DELETE ${key} failed: ${res.status}`);
            }
          }),
        );
        settled.forEach((r, idx) => { if (r.status === 'rejected') failed.push(slice[idx]); });
      }
      if (failed.length) throw new R2DeleteError(failed);
    },

    // Presigned GET URL (SigV4 query signing). The browser uses it directly for
    // <a href> / <img src>, so no auth header and no bucket CORS is involved. The
    // object's stored Content-Disposition decides open-vs-download.
    async presignGet(key, opts = {}) {
      const { cfg, client, endpoint } = resolve();
      const url = new URL(objectUrl(endpoint, cfg.bucket, key));
      // Must be on the URL BEFORE signing (it joins the canonical query);
      // aws4fetch would otherwise default S3 query-signed URLs to 24 h.
      const expires = Math.max(1, Math.floor(opts.expiresSeconds ?? PRESIGN_DEFAULT_EXPIRES_SECONDS));
      url.searchParams.set('X-Amz-Expires', String(expires));
      const signed = await client.sign(url.toString(), {
        method: 'GET',
        aws: { signQuery: true, ...(opts.datetime ? { datetime: opts.datetime } : {}) },
      });
      return signed.url;
    },
  };
}

// ---------------------------------------------------------------------------
// There are deliberately NO bare putObject/deleteKeys wrappers: every caller
// names its store (brandAssetsStore() or attachmentsStore()) so customer files
// can't drift into the public bucket by picking the "default" function.

// Public read URL for a brand-asset object, built from the bucket's configured
// public base (r2.dev URL or custom domain). Not signed — public access is
// granted at the bucket level in Cloudflare. Only the brand-assets bucket has
// one; attachments are never public.
export function publicUrl(key: string): string {
  const base = env.R2_PUBLIC_BASE_URL;
  if (!base) {
    throw new Error(
      'Cloudflare R2 public base is not configured — set R2_PUBLIC_BASE_URL in api/.env (see api/.env.example).',
    );
  }
  // Tolerate a trailing slash in the configured base so we never produce `//`.
  return `${base.replace(/\/+$/, '')}/${encodeKey(key)}`;
}

// ---------------------------------------------------------------------------
// Helpers

// URI-encode an object key for use in a URL path: each "/"-delimited segment is
// encoded, but the slashes between segments are preserved (S3 treats the key as
// a path). aws4fetch canonicalises the same URL for signing, so the signature
// matches what we send. Exported for unit testing.
export function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function objectUrl(endpoint: string, bucket: string, key: string): string {
  return `${endpoint}/${bucket}/${encodeKey(key)}`;
}

// Extract object keys from a ListObjectsV2 XML response. Our keys are safe
// ASCII (uuid segments + sanitised filenames), so a simple <Key> scan + entity
// decode is sufficient — no XML parser needed. Exported for unit testing.
export function parseListKeysXml(xml: string): string[] {
  return [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => decodeXmlEntities(m[1]));
}

// Build a Content-Disposition header value for a stored object (RFC 6266 +
// RFC 5987). `filename` is untrusted (email attachment names): CR/LF, quotes
// and backslashes can't reach the header, non-ASCII goes only into the
// percent-encoded `filename*` form with an ASCII fallback in `filename`.
export function contentDispositionFor(kind: 'inline' | 'attachment', filename: string): string {
  // Truncate by code point (not UTF-16 unit) so an emoji is never cut in half,
  // and drop lone surrogates a bad MIME decode may have produced — either
  // would make encodeURIComponent throw.
  const cleaned = Array.from((filename ?? '').replace(/[\r\n\t\0]+/g, ' ').trim())
    .filter((ch) => !/[\uD800-\uDFFF]/.test(ch) || ch.length === 2)
    .slice(0, 200)
    .join('');
  const base = cleaned || 'file';
  const ascii = base.replace(/["\\]/g, '_').replace(/[^\x20-\x7e]/g, '_');
  const utf8 = encodeURIComponent(base).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
