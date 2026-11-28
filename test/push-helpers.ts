// Test helpers that play the part of a browser: fake subscriptions and the decrypting side of Web Push.
import assert from 'node:assert/strict';
import { b64uDecode, b64uEncode } from '../src/webpush.ts';

const dec = new TextDecoder();
const enc = new TextEncoder();

export async function ecdhPair(privateB64u: string, publicB64u: string): Promise<CryptoKeyPair> {
  const pub = b64uDecode(publicB64u);
  const jwk = { kty: 'EC', crv: 'P-256', d: privateB64u, x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)), ext: true };
  const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const { d: _d, ...pubJwk } = jwk;
  const publicKey = await crypto.subtle.importKey('jwk', pubJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  return { privateKey, publicKey };
}

/** Independent decryptor (the user-agent side), written from RFC 8188/8291. */
export async function decrypt(body: Uint8Array, uaPrivate: string, uaPublic: string, auth: string): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  assert.equal(rs, 4096);
  const ua = await ecdhPair(uaPrivate, uaPublic);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const hk = async (ikm: Uint8Array, s: Uint8Array, info: Uint8Array, n: number) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
  const cat = (...a: Uint8Array[]) => Uint8Array.from(a.flatMap((x) => [...x]));
  const ikm = await hk(ecdh, b64uDecode(auth), cat(enc.encode('WebPush: info\0'), b64uDecode(uaPublic), asPublic), 32);
  const cek = await hk(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), cipher));
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
  return dec.decode(plain.slice(0, -1));
}

/** A fake browser subscription: the keys a real PushSubscription would hold. */
export async function newBrowserSubscription() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  const p256dh = b64uEncode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const auth = b64uEncode(crypto.getRandomValues(new Uint8Array(16)));
  return { p256dh, auth, d: jwk.d as string };
}

