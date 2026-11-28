// Web Push without dependencies, using Web Crypto only (works in Workers and in Node):
//  - RFC 8030  delivery: POST the encrypted message to the subscription's endpoint
//  - RFC 8291  message encryption (aes128gcm content coding, RFC 8188)
//  - RFC 8292  VAPID: a signed JWT that identifies this server to the push service

const enc = new TextEncoder();

// ---------- base64url ----------
export function b64uEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const isB64u = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s);

export function b64uDecode(s: string): Uint8Array {
  if (!isB64u(s)) throw new Error('not base64url');
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------- message encryption (RFC 8291) ----------
const RECORD_SIZE = 4096; // one record is always enough: messages here are a few hundred bytes
/** Push services must accept 4096 bytes in total; header (86) + tag (16) + delimiter (1) come on top. */
export const MAX_PLAINTEXT = 3000;

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** The key schedule of RFC 8291 section 3.4 (exported so the tests can check each step against the RFC). */
export async function deriveContentKeys(
  asPrivate: CryptoKey,
  asPublic: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  salt: Uint8Array,
) {
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));
  // PRK_key = HMAC(auth_secret, ecdh); IKM = HKDF-Expand(PRK_key, "WebPush: info" || 0 || ua_public || as_public, 32)
  const ikm = await hkdf(ecdh, authSecret, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 12);
  return { ecdh, ikm, cek, nonce };
}

export interface SubscriptionKeys {
  p256dh: string; // base64url, uncompressed P-256 point (65 bytes)
  auth: string; // base64url, 16 bytes
}

export interface EncryptOptions {
  /** Fixed values, for tests only. */
  ephemeral?: CryptoKeyPair;
  salt?: Uint8Array;
}

/** Returns the complete request body: aes128gcm header followed by the single encrypted record. */
export async function encryptPayload(
  sub: SubscriptionKeys,
  plaintext: Uint8Array,
  opts: EncryptOptions = {},
): Promise<Uint8Array> {
  const uaPublic = b64uDecode(sub.p256dh);
  const authSecret = b64uDecode(sub.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error('invalid subscription keys');
  if (plaintext.length > MAX_PLAINTEXT) throw new Error('payload too large');

  const eph =
    opts.ephemeral ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const { cek, nonce } = await deriveContentKeys(eph.privateKey, asPublic, uaPublic, authSecret, salt);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 marks the last (here: only) record; no padding.
  const record = concat(plaintext, new Uint8Array([2]));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, record));

  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

// ---------- VAPID (RFC 8292) ----------
export interface VapidKeys {
  publicKey: string; // base64url, uncompressed point (this is the "applicationServerKey")
  privateKey: string; // base64url, the 32-byte private scalar
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey: b64uEncode(pub), privateKey: jwk.d as string };
}

/** `Authorization` header value for a push service whose origin is `audience`. */
export async function vapidAuthorization(
  audience: string,
  subject: string,
  keys: VapidKeys,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<string> {
  const pub = b64uDecode(keys.publicKey);
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)), ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const head = b64uEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  // Push services reject tokens that live longer than 24 hours.
  const body = b64uEncode(enc.encode(JSON.stringify({ aud: audience, exp: nowSec + 12 * 3600, sub: subject })));
  // Web Crypto returns the raw r||s form that JWT (ES256) expects.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`)));
  return `vapid t=${head}.${body}.${b64uEncode(sig)}, k=${keys.publicKey}`;
}

// ---------- delivery (RFC 8030) ----------
export interface PushTarget extends SubscriptionKeys {
  endpoint: string;
}

export interface SendOptions {
  keys: VapidKeys;
  subject: string;
  /** Seconds the push service may hold the message for an offline device. */
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface SendResult {
  status: number;
  ok: boolean;
  /** 404/410: the subscription no longer exists and must be deleted. */
  gone: boolean;
}

export async function sendWebPush(target: PushTarget, message: unknown, o: SendOptions): Promise<SendResult> {
  const body = await encryptPayload(target, enc.encode(JSON.stringify(message)));
  const audience = new URL(target.endpoint).origin;
  const headers = {
    authorization: await vapidAuthorization(audience, o.subject, o.keys),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(o.ttl ?? 86_400),
    urgency: o.urgency ?? 'normal',
  };
  const doFetch = o.fetchImpl ?? fetch;
  const res = await doFetch(target.endpoint, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(o.timeoutMs ?? 8000),
  });
  // We never need the response body; release the connection.
  try {
    await res.body?.cancel();
  } catch {
    /* ignore */
  }
  return { status: res.status, ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410 };
}
