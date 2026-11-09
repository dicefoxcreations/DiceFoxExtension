/* Ids the way AnotherWorldbuilder's own converters make them
   (tools/import/awpack.py): derived from what a thing is — a URL, a file's
   bytes — so sending the same library twice adds nothing new, and a world
   built from the Python converter recognises every document again.
   BLAKE2b (RFC 7693) is written out here; browsers do not offer it. */
(() => {
  'use strict';
  const IV = new Uint32Array([
    0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
    0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
  ]);
  const SIGMA = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
    11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
    7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
    9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
    2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
    12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
    13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
    6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
    10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  ].map(x => x * 2);
  const v = new Uint32Array(32), m = new Uint32Array(32);

  // 64-bit words as pairs of 32-bit halves: low at i, high at i + 1.
  function add(a, b) {
    const lo = v[a] + v[b];
    v[a + 1] = v[a + 1] + v[b + 1] + (lo >= 0x100000000 ? 1 : 0);
    v[a] = lo;
  }
  function addm(a, lo0, hi0) {
    const lo = v[a] + lo0;
    v[a + 1] = v[a + 1] + hi0 + (lo >= 0x100000000 ? 1 : 0);
    v[a] = lo;
  }
  function g(a, b, c, d, ix, iy) {
    add(a, b); addm(a, m[ix], m[ix + 1]);
    let lo = v[d] ^ v[a], hi = v[d + 1] ^ v[a + 1];
    v[d] = hi; v[d + 1] = lo; // rotate 32
    add(c, d);
    lo = v[b] ^ v[c]; hi = v[b + 1] ^ v[c + 1];
    v[b] = (lo >>> 24) ^ (hi << 8); v[b + 1] = (hi >>> 24) ^ (lo << 8); // rotate 24
    add(a, b); addm(a, m[iy], m[iy + 1]);
    lo = v[d] ^ v[a]; hi = v[d + 1] ^ v[a + 1];
    v[d] = (lo >>> 16) ^ (hi << 16); v[d + 1] = (hi >>> 16) ^ (lo << 16); // rotate 16
    add(c, d);
    lo = v[b] ^ v[c]; hi = v[b + 1] ^ v[c + 1];
    v[b] = (hi >>> 31) ^ (lo << 1); v[b + 1] = (lo >>> 31) ^ (hi << 1); // rotate 63
  }
  function compress(s, last) {
    for (let i = 0; i < 16; i++) { v[i] = s.h[i]; v[i + 16] = IV[i]; }
    v[24] ^= s.t; v[25] ^= Math.floor(s.t / 0x100000000);
    if (last) { v[28] = ~v[28]; v[29] = ~v[29]; }
    for (let i = 0; i < 32; i++) m[i] = s.b[4 * i] ^ (s.b[4 * i + 1] << 8) ^ (s.b[4 * i + 2] << 16) ^ (s.b[4 * i + 3] << 24);
    for (let r = 0; r < 12; r++) {
      const x = r * 16;
      g(0, 8, 16, 24, SIGMA[x], SIGMA[x + 1]);
      g(2, 10, 18, 26, SIGMA[x + 2], SIGMA[x + 3]);
      g(4, 12, 20, 28, SIGMA[x + 4], SIGMA[x + 5]);
      g(6, 14, 22, 30, SIGMA[x + 6], SIGMA[x + 7]);
      g(0, 10, 20, 30, SIGMA[x + 8], SIGMA[x + 9]);
      g(2, 12, 22, 24, SIGMA[x + 10], SIGMA[x + 11]);
      g(4, 14, 16, 26, SIGMA[x + 12], SIGMA[x + 13]);
      g(6, 8, 18, 28, SIGMA[x + 14], SIGMA[x + 15]);
    }
    for (let i = 0; i < 16; i++) s.h[i] = s.h[i] ^ v[i] ^ v[i + 16];
  }
  /* BLAKE2b without a key, `size` bytes long. */
  function blake2b(bytes, size = 16) {
    const s = { h: new Uint32Array(IV), t: 0, c: 0, b: new Uint8Array(128) };
    s.h[0] ^= 0x01010000 ^ size;
    for (let i = 0; i < bytes.length; i++) {
      if (s.c === 128) { s.t += 128; compress(s, false); s.c = 0; }
      s.b[s.c++] = bytes[i];
    }
    s.t += s.c;
    while (s.c < 128) s.b[s.c++] = 0;
    compress(s, true);
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) out[i] = s.h[i >> 2] >>> (8 * (i & 3));
    return out;
  }

  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const utf8 = text => new TextEncoder().encode(text);
  const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

  /* A ULID-shaped id from a hash — the same for the same input. */
  function ulidOf(...parts) {
    let n = BigInt('0x' + hex(blake2b(utf8(parts.join('\0')), 16)));
    let out = '';
    for (let i = 0; i < 26; i++) { out = CROCKFORD[Number(n & 31n)] + out; n >>= 5n; }
    return out;
  }
  const articleId = (...parts) => 'art:' + ulidOf('article', ...parts);
  /* An image's id by its bytes, as a package names it. */
  function imageId(bytes) {
    const digest = hex(blake2b(bytes, 16));
    return `img:${digest.slice(0, 12)}-${ulidOf('image', digest)}`;
  }
  /* A link as stored: `@@art:…|text@@`. */
  function link(target, text) {
    const t = String(text || '').replace(/@@/g, '').replace(/\|/g, '/').trim();
    return t ? `@@${target}|${t}@@` : `@@${target}@@`;
  }

  globalThis.AWIds = Object.freeze({ blake2b, hex, ulidOf, articleId, imageId, link });
})();
