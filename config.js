require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);
const STORE_NAME = process.env.STORE_NAME || 'Premium Store';
// Username bot TANPA "@" (contoh: "PremiumStoreBot") - dipakai untuk bikin
// link referral pribadi https://t.me/<username>?start=<chatId>. Kalau kosong,
// menu referral otomatis kasih peringatan supaya diisi dulu di .env.
const BOT_USERNAME = process.env.BOT_USERNAME || '';
// Nominal saldo (USD) yang didapat PENGUNDANG setiap kali temannya buka
// bot lewat link referral untuk pertama kali. Bisa diubah lewat .env.
const REFERRAL_REWARD = Number(process.env.REFERRAL_REWARD || 1);

// ===== Pembayaran otomatis (Wallet Topup) =====
// QRIS via PayKita (pay.digikita.id) - lihat payment.js untuk detail integrasi
const PAYKITA_API_KEY = process.env.PAYKITA_API_KEY || '';
const PAYKITA_API_BASE = process.env.PAYKITA_API_BASE || 'https://paykita.biz.id';
// USDT jaringan BEP20 (BNB Smart Chain) - dideteksi otomatis lewat BscScan API
const USDT_BEP20_ADDRESS = process.env.USDT_BEP20_ADDRESS || '';
const USDT_BEP20_CONTRACT = process.env.USDT_BEP20_CONTRACT || '0x55d398326f99059fF775485246999027B3197955';
// TON / Toncoin (The Open Network) - dideteksi otomatis lewat TonCenter API
const TON_ADDRESS = process.env.TON_ADDRESS || '';
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY || '';
// Toko sudah pakai USD dan USDT dipatok ~1:1 ke USD, jadi tidak perlu kurs konversi lagi.

// Binance Pay (transfer C2C ke Binance ID/Pay ID pribadi milik toko) -
// dideteksi otomatis lewat endpoint resmi Binance "Get Pay Trade History"
// (GET /sapi/v1/pay/transactions). Ini API KEY BIASA (bukan Binance Pay
// Merchant/khusus bisnis) - dibuat langsung dari akun Binance pribadi lewat
// binance.com -> Profile -> API Management, tinggal centang permission
// "Enable Reading" (JANGAN aktifkan permission trading/withdraw sama sekali
// demi keamanan - fitur ini cuma butuh baca histori). Lihat payment.js untuk
// detail integrasi & cara kerja pencocokan nominal uniknya.
const BINANCE_API_KEY = process.env.BINANCE_API_KEY || '';
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET || '';
// Binance ID / Pay ID kamu sendiri (angka yang ditampilkan ke buyer supaya
// mereka kirim lewat menu "Pay" di app Binance) - HANYA dipakai buat
// ditampilkan ke buyer, tidak dipakai manggil API apapun.
const BINANCE_PAY_ID = process.env.BINANCE_PAY_ID || '';

// ===== Supplier API "AIVerse Hub" (https://aiversehub.store) =====
// Dipakai fitur "Supplier API" di /admin - varian produk lokal bisa
// dihubungkan ke sebuah service_id AIVerse Hub, supaya begitu ada buyer
// beli, bot otomatis pesan produknya lewat API mereka (bukan dari stok
// lokal) dan langsung teruskan hasilnya ke buyer. Lihat supplier.js.
const AIVERSEHUB_API_KEY = process.env.AIVERSEHUB_API_KEY || '';
const AIVERSEHUB_BASE_URL = process.env.AIVERSEHUB_BASE_URL || 'https://aiversehub.store';
// Setiap berapa menit bot otomatis sinkron ulang modal & stok semua varian
// yang terhubung ke Supplier API, TANPA admin perlu klik "🔄 Refresh Modal &
// Stok" manual. Default 10 menit, bisa diubah lewat .env. Isi 0 untuk
// matikan auto-sync (kembali ke refresh manual saja).
const SUPPLIER_SYNC_INTERVAL_MINUTES = Number(process.env.SUPPLIER_SYNC_INTERVAL_MINUTES ?? 10);

// ===== Supplier API "Canboso" (https://canboso.com) =====
// Dipakai fitur "🔌 Canboso API" di /admin - sama konsepnya dengan Supplier
// API (AIVerse Hub) di atas, tapi supplier KEDUA yang terpisah - varian
// produk lokal bisa dihubungkan ke sebuah product_id Canboso. Lihat
// supplierCanboso.js untuk detail integrasi API-nya.
const CANBOSO_API_KEY = process.env.CANBOSO_API_KEY || '';
const CANBOSO_BASE_URL = process.env.CANBOSO_BASE_URL || 'https://canboso.com';
// Setiap berapa DETIK bot otomatis sinkron ulang modal & stok semua varian
// yang terhubung ke Canboso API, TANPA admin perlu klik "🔄 Refresh Harga &
// Stok" manual - sama konsepnya dengan SUPPLIER_SYNC_INTERVAL_MINUTES di
// atas, tapi pakai satuan DETIK (bukan menit) supaya bisa diatur lebih
// rapat kalau perlu (mis. 30 detik), karena endpoint Canboso yang dipakai
// di sini (GET /api/v2/telegram-buyer/products) sudah dipanggil per-buyer
// juga (live check saat buka halaman produk, di-cache 20 detik - lihat
// supplierCanboso.js), jadi auto-sync background ini hanya perlu cukup
// rapat untuk menjaga angka di PANEL ADMIN tetap segar, bukan sumber
// kebenaran utama buat buyer (itu tetap live check per-buyer).
// Default 60 (1 menit). Isi 0 untuk matikan auto-sync (refresh manual saja).
// Nilai 1-9 detik OTOMATIS dinaikkan ke minimum 10 detik (lihat
// scheduleCanbosoSync() di bot.js) supaya tidak memicu rate limit 429
// Canboso kalau ada banyak varian terhubung.
const CANBOSO_SYNC_INTERVAL_SECONDS = Number(process.env.CANBOSO_SYNC_INTERVAL_SECONDS ?? 60);

// ===== Userbot GramJS (fitur "🎁 Buy Gift" / "💌 Confess Gift") =====
// Lihat userbot.js untuk detail integrasi & userbot-login.js untuk cara
// dapat USERBOT_SESSION. API_ID/API_HASH didapat dari https://my.telegram.org.
const USERBOT_API_ID = Number(process.env.USERBOT_API_ID || 0);
const USERBOT_API_HASH = process.env.USERBOT_API_HASH || '';
const USERBOT_SESSION = process.env.USERBOT_SESSION || '';
// Markup jual ulang gift ke buyer, dalam PERSEN di atas harga modal Stars
// (dikonversi ke USD pakai STARS_TO_USD_RATE). Contoh: gift 15 stars,
// STARS_TO_USD_RATE 0.015 -> modal $0.225, markup 30% -> harga jual $0.2925.
const GIFT_MARKUP_PCT = Number(process.env.GIFT_MARKUP_PCT ?? 30);
// Kurs konversi 1 Telegram Star -> USD, dipakai buat hitung harga jual gift
// dalam mata uang toko (USD). Harga resmi 1 Star ~= $0.013-$0.015 tergantung
// wilayah pembelian Stars - sesuaikan kalau beda.
const STARS_TO_USD_RATE = Number(process.env.STARS_TO_USD_RATE || 0.015);

// ===== 👉 UBAH ANGKA MARKUP DI SINI 👈 =====
// Dipakai untuk varian yang terhubung ke Supplier API DAN belum punya
// `tierMarkup` sendiri di data/db.json (lihat db.setVariantTierMarkup untuk
// override per-varian). Setiap kali modal (harga Supplier) berubah dan
// disinkron (auto-sync tiap SUPPLIER_SYNC_INTERVAL_MINUTES atau tombol
// "🔄 Refresh Modal & Stok" manual di /admin), 3 tier harga jual di bawah
// dihitung ULANG otomatis dari modal terbaru + persentase markup ini -
// jadi harga jual SELALU "sesuai/ikut" harga live Supplier, bukan angka
// manual yang bisa basi.
//
// markupPct = berapa persen di atas modal. Contoh: modal $0.40, markupPct 25
// -> harga jual = $0.40 * 1.25 = $0.50.
//
// Angka di bawah ini CUMA PLACEHOLDER (silakan ganti sesuka hati kapan saja,
// tidak perlu restart kode lain, tinggal edit lalu save & jalankan ulang bot):
const DEFAULT_SUPPLIER_TIER_MARKUP = [
  { min: 1, max: 49, markupPct: 25 },   // qty 1-49   -> modal + 25%
  { min: 50, max: 499, markupPct: 15 }, // qty 50-499 -> modal + 15%
  { min: 500, max: null, markupPct: 8 } // qty 500+   -> modal + 8%
];

// Custom emoji Telegram Premium (emoji_id) — TIDAK lewat .env.
// Diisi langsung di 2 file terpisah sesuai jenis pemakaiannya:
// - ./emoji-id-teks.js        -> emoji di teks (deskripsi produk & menu/notifikasi)
// - ./emoji-id-menu-inline.js -> emoji di ikon tombol menu inline, per tombol
//   (object EMOJI_IDS + helper iconFor(key) - diimpor langsung oleh bot.js,
//   tidak lewat config ini lagi, karena sekarang ID-nya banyak/per-key bukan 1 nilai)
const { EMOJI_ID_PRODUCT_DESC, EMOJI_ID_MENU_NOTIF } = require('./emoji-id-teks');
const BOLT_EMOJI_ID_TEXT = EMOJI_ID_PRODUCT_DESC;
const BOLT_EMOJI_ID_MENU = EMOJI_ID_MENU_NOTIF;

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN belum diset di file .env');
  process.exit(1);
}

function isAdmin(chatId) {
  return ADMIN_IDS.includes(Number(chatId));
}

module.exports = {
  BOT_TOKEN, ADMIN_IDS, STORE_NAME, BOT_USERNAME, REFERRAL_REWARD, BOLT_EMOJI_ID_TEXT, BOLT_EMOJI_ID_MENU, isAdmin,
  PAYKITA_API_KEY, PAYKITA_API_BASE,
  USDT_BEP20_ADDRESS, USDT_BEP20_CONTRACT,
  TON_ADDRESS, TONCENTER_API_KEY,
  BINANCE_API_KEY, BINANCE_API_SECRET, BINANCE_PAY_ID,
  AIVERSEHUB_API_KEY, AIVERSEHUB_BASE_URL, SUPPLIER_SYNC_INTERVAL_MINUTES, DEFAULT_SUPPLIER_TIER_MARKUP,
  CANBOSO_API_KEY, CANBOSO_BASE_URL, CANBOSO_SYNC_INTERVAL_SECONDS,
  USERBOT_API_ID, USERBOT_API_HASH, USERBOT_SESSION, GIFT_MARKUP_PCT, STARS_TO_USD_RATE
};

