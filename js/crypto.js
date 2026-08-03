/* ============================================================
 * crypto.js — 与桌面版 mathlan1222.py 完全一致的加密实现
 * MD5 / SHA-256 / AnswerCrypto / PasswordGenerator
 * ============================================================ */
(function (global) {
'use strict';

/* ---------- UTF-8 编码 ---------- */
function utf8Bytes(str) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
  var out = [], i, c;
  for (i = 0; i < str.length; i++) {
    c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
    else if (c >= 0xd800 && c <= 0xdbff) {
      var c2 = str.charCodeAt(++i);
      var cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/* ---------- MD5 (RFC 1321) ---------- */
var MD5_S = [7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
             5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
             4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
             6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21];
var MD5_K = [];
for (var _i = 0; _i < 64; _i++) MD5_K[_i] = Math.floor(Math.abs(Math.sin(_i + 1)) * 4294967296);

function md5Hex(input) {
  var msg = utf8Bytes(input);
  var bitLen = msg.length * 8;
  var len = msg.length;
  var padded = [];
  var i;
  for (i = 0; i < len; i++) padded[i] = msg[i];
  padded[len] = 0x80;
  while (padded.length % 64 !== 56) padded.push(0);
  for (i = 0; i < 4; i++) padded.push((bitLen >>> (i * 8)) & 0xff);
  for (i = 0; i < 4; i++) padded.push(0); // 长度高32位（题目/密钥很短，恒为0）

  var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (var off = 0; off < padded.length; off += 64) {
    var M = [];
    for (i = 0; i < 16; i++) {
      M[i] = padded[off + i * 4] | (padded[off + i * 4 + 1] << 8) |
             (padded[off + i * 4 + 2] << 16) | (padded[off + i * 4 + 3] << 24);
    }
    var A = a0, B = b0, C = c0, D = d0;
    for (i = 0; i < 64; i++) {
      var F, g;
      if (i < 16)      { F = (B & C) | (~B & D);        g = i; }
      else if (i < 32) { F = (D & B) | (~D & C);        g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D;                 g = (3 * i + 5) % 16; }
      else             { F = C ^ (B | ~D);              g = (7 * i) % 16; }
      F = (F + A + MD5_K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      var s = MD5_S[i];
      B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  function le(w) {
    var s = '';
    for (var j = 0; j < 4; j++) s += ('0' + ((w >>> (j * 8)) & 0xff).toString(16)).slice(-2);
    return s;
  }
  return le(a0) + le(b0) + le(c0) + le(d0);
}

/* ---------- SHA-256 (FIPS 180-4) ---------- */
function _primes(n) {
  var ps = [], x = 2;
  while (ps.length < n) {
    var ok = true;
    for (var i = 0; i < ps.length && ps[i] * ps[i] <= x; i++) if (x % ps[i] === 0) { ok = false; break; }
    if (ok) ps.push(x);
    x++;
  }
  return ps;
}
var SHA256_K, SHA256_H0;
(function () {
  var ps = _primes(64);
  SHA256_K = []; SHA256_H0 = [];
  for (var i = 0; i < 64; i++) SHA256_K[i] = Math.floor((Math.cbrt(ps[i]) % 1) * 4294967296);
  for (i = 0; i < 8; i++) SHA256_H0[i] = Math.floor((Math.sqrt(ps[i]) % 1) * 4294967296);
})();

function sha256Hex(input) {
  var msg = utf8Bytes(input);
  var bitLenHi = Math.floor(msg.length / 0x20000000); // length*8 的高32位
  var bitLenLo = (msg.length * 8) >>> 0;
  var padded = [];
  var i;
  for (i = 0; i < msg.length; i++) padded[i] = msg[i];
  padded[msg.length] = 0x80;
  while (padded.length % 64 !== 56) padded.push(0);
  padded.push((bitLenHi >>> 24) & 0xff, (bitLenHi >>> 16) & 0xff, (bitLenHi >>> 8) & 0xff, bitLenHi & 0xff,
              (bitLenLo >>> 24) & 0xff, (bitLenLo >>> 16) & 0xff, (bitLenLo >>> 8) & 0xff, bitLenLo & 0xff);

  var H = SHA256_H0.slice();
  var w = new Array(64);
  for (var off = 0; off < padded.length; off += 64) {
    for (i = 0; i < 16; i++) {
      w[i] = (padded[off + i * 4] << 24) | (padded[off + i * 4 + 1] << 16) |
             (padded[off + i * 4 + 2] << 8) | padded[off + i * 4 + 3];
    }
    for (i = 16; i < 64; i++) {
      var w15 = w[i - 15], w2 = w[i - 2];
      var s0 = (((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3)) >>> 0;
      var s1 = (((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (i = 0; i < 64; i++) {
      var S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
      var ch = ((e & f) ^ (~e & g)) >>> 0;
      var t1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
      var S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
      var mj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      var t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  var out = '';
  for (i = 0; i < 8; i++) out += ('0000000' + (H[i] >>> 0).toString(16)).slice(-8);
  return out;
}

/* ---------- AnswerCrypto（与桌面版一致） ---------- */
var AnswerCrypto = {
  generateKey: function (questionText) {
    var h = md5Hex(questionText || '');
    var k = (parseInt(h.slice(0, 8), 16) % 1000000).toString();
    while (k.length < 6) k = '0' + k;
    return k;
  },
  decryptAnswer: function (encrypted, questionText) {
    questionText = questionText || '';
    if (!encrypted || encrypted.indexOf('ENC:') !== 0) return encrypted;
    try {
      var parts = encrypted.split(':');
      var fingerprint = parts[1];
      var text = parts.slice(2).join(':');
      var key = this.generateKey(questionText);
      if (md5Hex(key + questionText).slice(0, 8) !== fingerprint) return encrypted;
      var out = '';
      for (var i = 0; i < text.length; i++) {
        out += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % 6) ^ ((i * 7) % 256));
      }
      return out;
    } catch (e) {
      return encrypted;
    }
  }
};

/* ---------- PasswordGenerator（与桌面版一致：SHA256 -> 大整数 -> 62进制6位） ---------- */
var CHAR_SET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
function generatePassword(phone) {
  if (!/^\d{11}$/.test(phone)) return null;
  var hex = sha256Hex(phone);
  var n = BigInt('0x' + hex);
  var base = BigInt(62);
  var pwd = '';
  for (var i = 0; i < 6; i++) {
    pwd += CHAR_SET[Number(n % base)];
    n = n / base;
  }
  return pwd;
}

global.MLCrypto = {
  md5Hex: md5Hex,
  sha256Hex: sha256Hex,
  AnswerCrypto: AnswerCrypto,
  generatePassword: generatePassword
};
})(window);
