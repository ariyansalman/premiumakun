// ============================================================
// TOTP (Time-based One-Time Password) generator - RFC 6238
// ============================================================
// Implementasi lokal, TANPA dependency ke library luar maupun ke situs
// pihak ketiga (mis. https://2fa.cn/). Situs semacam itu sendiri cuma
// menghitung TOTP standar 100% di browser milik pengguna - tidak ada
// API server sama sekali (lihat FAQ resminya: "All code generation is
// done entirely on the client side"). Karena itu, satu-satunya cara
// "integrasi" yang benar & stabil adalah menghitung kodenya sendiri di
// sini - hasilnya akan SELALU identik dengan yang ditampilkan 2fa.cn
// untuk secret yang sama, tanpa harus bergantung ke situs luar yang
// bisa berubah/lambat/down.
//
// Secret yang didukung: Base32 standar (RFC 4648) - huruf A-Z dan angka
// 2-7, boleh pakai spasi & huruf kecil (otomatis dibersihkan &
// di-uppercase) - persis format yang dipakai Google Authenticator,
// Authy, dan 2fa.cn. Contoh: "kqzj jo6v m3ob nywd ag7m b4uo foa4 mzby"
// atau "KQZJJO6VM3OBNYWDAG7MB4UOFOA4MZBY" (tanpa spasi) - dua-duanya
// menghasilkan kode yang sama.

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  const clean = String(input).replace(/\s+/g, '').replace(/=+$/, '').toUpperCase();
  if (!clean.length) return null;
  let bits = '';
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) return null; // karakter di luar alphabet base32 -> bukan secret valid
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return bytes.length ? Buffer.from(bytes) : null;
}

// Cek cepat apakah sebuah string "kelihatan seperti" TOTP secret base32
// (bukan kode OTP statis 6 digit gaya lama). Minimal 16 karakter valid
// base32 supaya kode digit pendek yang lama tidak salah-kena dianggap
// secret (base32 tidak mengenal digit 0/1/8/9, jadi kode digit lama
// hampir selalu otomatis gagal cek ini juga).
function looksLikeTotpSecret(input) {
  const clean = String(input).replace(/\s+/g, '').replace(/=+$/, '').toUpperCase();
  if (clean.length < 16) return false;
  return /^[A-Z2-7]+$/.test(clean);
}

function hotp(secretBuffer, counter, digits) {
  const counterBuffer = Buffer.alloc(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) {
    counterBuffer[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  const hmac = crypto.createHmac('sha1', secretBuffer).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  const otp = binCode % Math.pow(10, digits);
  return String(otp).padStart(digits, '0');
}

// Generate kode TOTP (default 6 digit, langkah waktu 30 detik - sama
// seperti default Google Authenticator, Authy, dan 2fa.cn). Return null
// kalau secret tidak valid base32.
function generateTOTP(secretRaw, { digits = 6, period = 30, timestamp = null } = {}) {
  const secretBuffer = base32Decode(secretRaw);
  if (!secretBuffer) return null;
  const nowSec = timestamp != null ? timestamp : Math.floor(Date.now() / 1000);
  const counter = Math.floor(nowSec / period);
  return hotp(secretBuffer, counter, digits);
}

// Sisa detik sebelum kode saat ini expired / berganti ke kode berikutnya.
function secondsRemaining(period = 30, timestamp = null) {
  const nowSec = timestamp != null ? timestamp : Math.floor(Date.now() / 1000);
  const rem = period - (nowSec % period);
  return rem === period ? period : rem;
}

module.exports = { base32Decode, looksLikeTotpSecret, generateTOTP, secondsRemaining };
