import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

test('icon generator writes valid PNGs referenced by the manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'icons-'));
  execFileSync('node', ['scripts/make-icons.mjs', dir]);
  const sizes: Record<string, number> = { 'icon-192.png': 192, 'icon-512.png': 512, 'icon-maskable-512.png': 512, 'apple-touch-icon.png': 180 };
  assert.deepEqual(readdirSync(dir).sort(), Object.keys(sizes).sort());
  for (const [name, size] of Object.entries(sizes)) {
    const buf = readFileSync(join(dir, name));
    assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(buf.readUInt32BE(16), size);
    assert.equal(buf.readUInt32BE(20), size);
    // IDAT must inflate to exactly (size*4+1)*size bytes.
    const idatStart = buf.indexOf(Buffer.from('IDAT')) + 4;
    const idatLen = buf.readUInt32BE(idatStart - 8);
    assert.equal(inflateSync(buf.subarray(idatStart, idatStart + idatLen)).length, (size * 4 + 1) * size);
  }
  const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8'));
  for (const icon of manifest.icons) assert.ok(icon.src.replace('/icons/', '') in sizes, `${icon.src} is generated`);
  const html = readFileSync('public/index.html', 'utf8');
  assert.ok(html.includes('/icons/apple-touch-icon.png'));
});
