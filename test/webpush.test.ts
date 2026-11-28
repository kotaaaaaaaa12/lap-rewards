// Checks the Web Push cryptography against the worked example in RFC 8291 (section 5),
// then round-trips with an independent decryptor, and verifies the VAPID token signature.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decrypt, ecdhPair, newBrowserSubscription } from './push-helpers.ts';
import {
  b64uDecode, b64uEncode, deriveContentKeys, encryptPayload, generateVapidKeys, sendWebPush, vapidAuthorization,
  MAX_PLAINTEXT,
} from '../src/webpush.ts';

const dec = new TextDecoder();
const enc = new TextEncoder();

// RFC 8291, section 5 ("Encrypted Message Example")
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  ecdh: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('key schedule matches the RFC 8291 example, step by step', async () => {
  const as = await ecdhPair(RFC.asPrivate, RFC.asPublic);
  const k = await deriveContentKeys(as.privateKey, b64uDecode(RFC.asPublic), b64uDecode(RFC.uaPublic), b64uDecode(RFC.auth), b64uDecode(RFC.salt));
  assert.equal(b64uEncode(k.ecdh), RFC.ecdh, 'ECDH shared secret');
  assert.equal(b64uEncode(k.ikm), RFC.ikm, 'IKM');
  assert.equal(b64uEncode(k.cek), RFC.cek, 'content encryption key');
  assert.equal(b64uEncode(k.nonce), RFC.nonce, 'nonce');
});

test('encryptPayload reproduces the RFC 8291 message byte for byte', async () => {
  const body = await encryptPayload(
    { p256dh: RFC.uaPublic, auth: RFC.auth },
    enc.encode(RFC.plaintext),
    { ephemeral: await ecdhPair(RFC.asPrivate, RFC.asPublic), salt: b64uDecode(RFC.salt) },
  );
  assert.equal(b64uEncode(body), RFC.body);
});

test('round trip with random keys, including non-ASCII text', async () => {
  const b = await newBrowserSubscription();
  const text = JSON.stringify({ title: 'ポイントが付与されました', body: '+10 pt · 第3単元のクイズに合格' });
  const body = await encryptPayload(b, enc.encode(text));
  assert.equal(await decrypt(body, b.d, b.p256dh, b.auth), text);
  assert.ok(body.length < 4096);
});

test('rejects malformed subscription keys and oversized payloads', async () => {
  const b = await newBrowserSubscription();
  await assert.rejects(encryptPayload({ p256dh: 'AAAA', auth: b.auth }, enc.encode('x')), /invalid subscription keys/);
  await assert.rejects(encryptPayload({ p256dh: b.p256dh, auth: 'AAAA' }, enc.encode('x')), /invalid subscription keys/);
  await assert.rejects(encryptPayload({ p256dh: 'not base64url!', auth: b.auth }, enc.encode('x')));
  await assert.rejects(encryptPayload(b, new Uint8Array(MAX_PLAINTEXT + 1)), /too large/);
  await encryptPayload(b, new Uint8Array(MAX_PLAINTEXT));
});

test('VAPID token: claims, expiry and a valid ES256 signature', async () => {
  const keys = await generateVapidKeys();
  assert.equal(b64uDecode(keys.publicKey).length, 65);
  assert.equal(b64uDecode(keys.privateKey).length, 32);
  const now = 1_800_000_000;
  const header = await vapidAuthorization('https://push.example', 'https://school.example', keys, now);
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  assert.ok(m, header);
  assert.equal(m![4], keys.publicKey);
  assert.deepEqual(JSON.parse(dec.decode(b64uDecode(m![1]))), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(dec.decode(b64uDecode(m![2])));
  assert.deepEqual(claims, { aud: 'https://push.example', exp: now + 12 * 3600, sub: 'https://school.example' });
  const pub = b64uDecode(keys.publicKey);
  const verifyKey = await crypto.subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const sig = b64uDecode(m![3]);
  assert.equal(sig.length, 64);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, sig, enc.encode(`${m![1]}.${m![2]}`)));
});

test('sendWebPush posts an encrypted body with the required headers and reports the outcome', async () => {
  const b = await newBrowserSubscription();
  const keys = await generateVapidKeys();
  let seen: { url: string; init: RequestInit } | null = null;
  const reply = (status: number) => (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  const target = { endpoint: 'https://web.push.apple.com/abc', p256dh: b.p256dh, auth: b.auth };

  const ok = await sendWebPush(target, { title: 'Hi' }, { keys, subject: 'https://school.example', fetchImpl: reply(201) });
  assert.deepEqual(ok, { status: 201, ok: true, gone: false });
  const h = seen!.init.headers as Record<string, string>;
  assert.equal(h['content-encoding'], 'aes128gcm');
  assert.equal(h['content-type'], 'application/octet-stream');
  assert.equal(h.ttl, '86400');
  assert.match(h.authorization, /^vapid t=.+, k=.+$/);
  assert.equal(await decrypt(seen!.init.body as Uint8Array, b.d, b.p256dh, b.auth), '{"title":"Hi"}');

  assert.deepEqual(await sendWebPush(target, {}, { keys, subject: 's', fetchImpl: reply(410) }), { status: 410, ok: false, gone: true });
  assert.deepEqual(await sendWebPush(target, {}, { keys, subject: 's', fetchImpl: reply(404) }), { status: 404, ok: false, gone: true });
  assert.deepEqual(await sendWebPush(target, {}, { keys, subject: 's', fetchImpl: reply(503) }), { status: 503, ok: false, gone: false });
});
