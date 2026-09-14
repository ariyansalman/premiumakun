// ============================================================
// supplierCanboso.js — Integrasi API "Supplier Canboso" (https://canboso.com)
// ============================================================
// Sama seperti supplier.js (AIVerse Hub), tapi untuk supplier KEDUA:
// Canboso. Dipakai untuk fitur "Canboso API": varian produk lokal bisa
// dihubungkan ke sebuah `product_id` di Canboso. Begitu ada buyer beli
// varian yang terhubung, bot memesan produknya SECARA OTOMATIS lewat API
// ini (bukan dari stok lokal `stockItems`) dan langsung meneruskan
// kode/link/akun yang dibalas API ke buyer — mirip dropship otomatis,
// persis pola yang sudah dipakai supplier.js.
//
// Dokumentasi resmi: https://canboso.com/api/swagger
// Endpoint yang dipakai:
//   GET  /api/v2/telegram-buyer/products  -> daftar produk yang tersedia
//   POST /api/v2/telegram-buyer/purchase  -> beli produk pakai saldo wallet
//        (saldo WALLET DI SISI CANBOSO milik akun API key ini — BUKAN saldo
//        Wallet buyer di bot ini, dua hal yang beda, sama seperti getMe()
//        di supplier.js. Wallet ini WAJIB di-top-up dulu dari sisi Canboso
//        sebelum purchase bisa jalan — kalau saldo kurang, API akan balas
//        error dan itu ditangkap sebagai Error biasa di bawah.)
//
// Auth: dokumentasi tidak menyebut eksplisit nama header di deskripsi
// singkat yang diberikan, jadi API key dikirim lewat 2 header sekaligus
// supaya tetap jalan apapun konvensi yang dipakai Canboso di baliknya:
//   - Authorization: Bearer <key>   (konvensi REST paling umum)
//   - X-API-Key: <key>              (konvensi dipakai supplier.js/AIVerse Hub)
// Kalau ternyata Canboso butuh nama header lain, tinggal cek 1x di
// https://canboso.com/api/swagger (coba "Authorize" di sana) lalu sesuaikan
// object `headers` di apiRequest() di bawah — cuma di 1 tempat.
// ============================================================

require('dotenv').config();
const crypto = require('crypto');

const CANBOSO_API_KEY = process.env.CANBOSO_API_KEY || '';
const CANBOSO_BASE_URL = (process.env.CANBOSO_BASE_URL || 'https://canboso.com').replace(/\/+$/, '');

// Sama seperti fetchWithTimeout() di supplier.js/payment.js - tanpa timeout,
// request yang hang (API supplier lambat/nge-freeze) bisa bikin proses
// pembelian user nge-gantung tanpa batas waktu.
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request timeout setelah ${timeoutMs / 1000}s: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function ensureConfigured() {
  if (!CANBOSO_API_KEY) {
    throw new Error('CANBOSO_API_KEY belum diisi di .env');
  }
}

// Request generik ke API Canboso. `query` (object) opsional untuk GET
// dengan query string, `body` (object) opsional untuk POST/PUT/dsb.
// Melempar Error dengan pesan jelas untuk semua kegagalan (network,
// timeout, HTTP non-2xx, rate limit, JSON tidak valid) supaya pemanggil
// tinggal try/catch tanpa perlu ngecek status manual lagi — pola sama
// seperti apiRequest() di supplier.js.
async function apiRequest(method, path, { query, body, headers } = {}) {
  ensureConfigured();
  let url = `${CANBOSO_BASE_URL}${path}`;
  if (query && Object.keys(query).length) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString();
    if (qs) url += `?${qs}`;
  }

  const res = await fetchWithTimeout(url, {
    method,
    headers: {
      'Authorization': `Bearer ${CANBOSO_API_KEY}`,
      'X-API-Key': CANBOSO_API_KEY,
      ...(body ? { 'content-type': 'application/json' } : {}),
      // Header tambahan per-request (mis. Idempotency-Key untuk POST
      // /purchase - lihat purchase() di bawah). Ditaruh SETELAH default
      // di atas supaya kalau suatu saat perlu override, caller menang.
      ...(headers || {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  if (res.status === 429) {
    throw new Error('Canboso: rate limit tercapai (429 Too Many Requests), coba lagi sebentar lagi.');
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Canboso: API key ditolak (HTTP ${res.status}) - cek ulang CANBOSO_API_KEY di .env.`);
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error(`Canboso: response bukan JSON (HTTP ${res.status}) di ${path}`);
  }

  if (!res.ok) {
    // ===== BUG FIX: sebelumnya cuma cek json.error/json.message/json.msg -
    // pola yang sama seperti bug penamaan field stok yang sudah ditemukan
    // sebelumnya (lihat getProducts() di bawah). Kalau field pesan error
    // asli Canboso ternyata namanya lain (mis. "detail", "reason", atau
    // dibungkus nested seperti {error: {message: "..."}}) - PALING SERING
    // kejadian ini justru pas kasus penting kayak "saldo wallet tidak
    // cukup" - admin cuma dapat "HTTP 400" generik tanpa tahu alasan
    // sebenarnya. Sekarang dicoba lebih banyak nama field + 1 level nested,
    // dan kalau semua tetap gagal, sertakan potongan raw JSON mentah
    // (bukan cuma "HTTP xxx") supaya admin tetap dapat petunjuk dari pesan
    // error-nya, sama seperti pendekatan describeRawFields() di bot.js.
    let msg = pick(json, ['error', 'message', 'msg', 'detail', 'reason', 'description', 'errorMessage', 'error_message']);
    if (msg && typeof msg === 'object') {
      msg = pick(msg, ['message', 'error', 'msg', 'detail', 'reason']) || JSON.stringify(msg).slice(0, 200);
    }
    if (!msg) msg = `HTTP ${res.status} (raw: ${JSON.stringify(json).slice(0, 200)})`;
    throw new Error(`Canboso API error di ${path}: ${msg}`);
  }

  return json;
}

// Ambil field pertama yang ADA (bukan undefined/null) dari sebuah object,
// dicoba berurutan dari daftar nama kandidat - dipakai supaya kode ini
// tahan terhadap variasi penamaan field yang mungkin dipakai Canboso
// (mis. "id" vs "product_id", "price" vs "cost") tanpa perlu tahu skema
// PERSIS 1:1 sebelumnya.
function pick(obj, keys, fallback) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return fallback;
}

// Konversi nilai APAPUN jadi number dengan aman - dipakai khusus untuk
// price/stock karena beberapa API (termasuk kemungkinan Canboso) balas
// angka dalam bentuk string berformat (mis. "$12.00", "12,000", "Rp15.000")
// atau dibungkus object (mis. { amount: 12, currency: "USD" }) alih-alih
// number mentah. Tanpa ini, Number("$12.00") -> NaN dan modal jadi
// "tidak diketahui" walau datanya sebenarnya ADA di response, cuma beda
// format. Return NaN kalau memang tidak bisa diparse sama sekali.
function toNumber(v) {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object') {
    // Diperluas: selain {amount}/{value}, beberapa API membungkus stok
    // sebagai {available}/{count}/{qty}/{stock} bersarang satu level -
    // dicoba semua supaya toNumber() tetap kena walau bentuknya nested.
    if (v.amount !== undefined) return toNumber(v.amount);
    if (v.value !== undefined) return toNumber(v.value);
    if (v.available !== undefined) return toNumber(v.available);
    if (v.count !== undefined) return toNumber(v.count);
    if (v.qty !== undefined) return toNumber(v.qty);
    if (v.stock !== undefined) return toNumber(v.stock);
  }
  if (typeof v === 'string') {
    const cleaned = v.replace(/[^0-9.\-]/g, '');
    return cleaned === '' ? NaN : parseFloat(cleaned);
  }
  return NaN;
}

// GET /api/v2/telegram-buyer/products - daftar semua produk yang tersedia
// di Canboso beserta harga & stoknya. Response API bisa saja membungkus
// array-nya di beberapa bentuk berbeda (langsung array, atau di dalam
// `data`/`products`/`result`) - dicoba semua supaya tetap jalan apapun
// bentuknya. Tiap item dinormalisasi jadi { id, name, price, stock, raw }
// supaya bagian lain (bot.js) tidak perlu tahu skema mentahnya.
async function getProducts() {
  const json = await apiRequest('GET', '/api/v2/telegram-buyer/products');
  const rawList = Array.isArray(json) ? json
    : Array.isArray(json.data) ? json.data
    : Array.isArray(json.products) ? json.products
    : Array.isArray(json.result) ? json.result
    : [];

  return rawList.map(item => ({
    id: pick(item, ['id', 'product_id', 'productId', 'slug']),
    name: pick(item, ['name', 'title', 'product_name'], 'Tanpa Nama'),
    price: toNumber(pick(item, ['price', 'cost', 'harga', 'sell_price', 'base_price', 'amount', 'price_usd', 'unit_price', 'modal', 'harga_modal'])),
    // PENTING: TIDAK ada fallback default 0 di sini (beda dari sebelumnya) -
    // kalau none dari nama field kandidat ini ketemu di response, hasilnya
    // harus NaN ("tidak diketahui"), BUKAN 0 ("dipastikan habis"). Fallback
    // 0 yang lama adalah BUG: bikin live stock check di bot.js salah
    // mengira produk yang field stoknya belum dikenali sebagai benar-benar
    // habis (0), padahal cuma gagal dibaca - baru ketahuan setelah live
    // stock check dipasang. `bot.js` sudah didesain aman terhadap NaN
    // (skip block, jangan simpan ke variant.stock) - jangan kasih fallback
    // angka apapun di sini lagi.
    // Diperluas dari daftar sebelumnya (stock/qty/quantity/available/stok/
    // remaining/available_stock) - ditambah nama-nama lain yang umum
    // dipakai marketplace akun premium sejenis, supaya makin kecil
    // kemungkinan stok tetap NaN gara-gara nama field yang belum ketebak.
    // 'availability' ditambahkan KHUSUS untuk skema Canboso yang sebenarnya
    // (dikonfirmasi dari 🐞 Raw Response): stok dibungkus di
    // { availability: { available: 9, sold: 141 } }, bukan field number
    // langsung - toNumber() di atas sudah baca v.available dari object
    // nested, jadi begitu 'availability' ada di daftar ini, pick() akan
    // balikin object itu dan toNumber() otomatis ambil angka `available`-nya.
    // Kalau SETELAH ini masih NaN, pastikan field-nya memang bukan salah
    // satu ini dengan 🐞 Lihat Raw Response (debug) di /admin -> Canboso
    // API, lalu tambahkan nama field aslinya ke daftar ini.
    stock: toNumber(pick(item, [
      'availability', 'stock', 'qty', 'quantity', 'available', 'stok', 'remaining',
      'available_stock', 'stock_count', 'stockCount', 'in_stock', 'inStock',
      'totalStock', 'total_stock', 'stok_tersedia', 'available_qty',
      'availableQty', 'qty_available', 'inventory', 'items_available',
      'itemsAvailable', 'left', 'remaining_stock', 'remainingStock', 'count'
    ])),
    raw: item
  })).filter(p => p.id !== undefined);
}

// Sama seperti getProducts(), tapi balikin JSON MENTAH apa adanya (tanpa
// normalisasi field) - dipakai KHUSUS oleh tombol debug "🐞 Lihat Raw
// Response" di /admin -> Canboso API, supaya kalau normalisasi field di
// getProducts() di atas ternyata meleset (nama field API beda dari
// dugaan), admin bisa langsung lihat bentuk response ASLI dari Telegram
// tanpa perlu buka Postman/curl terpisah, lalu kirim ke developer buat
// disesuaikan pemetaan field-nya di 1 tempat (getProducts() di atas).
async function getRawProducts() {
  return apiRequest('GET', '/api/v2/telegram-buyer/products');
}

// Cache singkat (default 20 detik) untuk getProducts() - dipakai oleh
// pengecekan STOK LIVE tiap kali buyer buka halaman varian/qty/confirm
// (lihat bot.js) supaya TIDAK memanggil API Canboso berkali-kali dalam
// hitungan detik kalau banyak buyer buka produk yang sama nyaris
// bersamaan (jaga rate limit). Admin tetap bisa lihat data paling baru
// kapan saja lewat "🔄 Refresh Harga & Stok" (panggil getProducts() versi
// TIDAK di-cache) atau "🐞 Lihat Raw Response" (getRawProducts()).
let productsCache = { data: null, ts: 0 };
async function getProductsCached(ttlMs = 20000) {
  const now = Date.now();
  if (productsCache.data && (now - productsCache.ts) < ttlMs) return productsCache.data;
  const data = await getProducts();
  productsCache = { data, ts: now };
  return data;
}

// Cari 1 produk Canboso by id dari daftar (live/cached) - dipakai untuk cek
// stok TERKINI sebelum buyer pilih jumlah & sebelum order benar-benar
// diproses, supaya angka yang dilihat/divalidasi buyer selalu ikut Canboso
// yang sebenarnya, bukan snapshot lokal yang bisa basi (lihat catatan bug
// stok di bot.js). Return null kalau id tidak ketemu di daftar sama sekali
// (produk sudah dihapus dari Canboso) - BUKAN 0, supaya pemanggil bisa
// membedakan "benar-benar habis" vs "gagal dicek/tidak ditemukan".
async function getLiveStock(productId, { cached = true } = {}) {
  const products = cached ? await getProductsCached() : await getProducts();
  return products.find(p => String(p.id) === String(productId)) || null;
}

// POST /api/v2/telegram-buyer/purchase - beli 1 produk pakai saldo wallet
// akun Canboso kita. `productId` wajib (ambil dari getProducts() -> .id),
// `quantity` default 1. Melempar Error (lihat apiRequest) kalau gagal
// (mis. saldo wallet Canboso kita habis/belum di-top-up, atau stok remote
// kosong). Return object hasil normalisasi:
//   { orderId, items, raw } — `items` berisi array string (kode/akun/link
//   hasil pembelian) yang siap diteruskan ke buyer, diambil dari beberapa
//   kemungkinan nama field balasan API supaya tahan variasi skema.
//
// ===== BUG FIX: Canboso MEWAJIBKAN header `Idempotency-Key` (8-128 char)
// di setiap POST /purchase - sebelumnya header ini TIDAK PERNAH dikirim
// sama sekali, jadi API langsung menolak dengan 400 "A valid
// Idempotency-Key header is required" SEBELUM sempat memotong saldo
// wallet Canboso ataupun stok remote-nya. Efeknya: order selalu gagal di
// pemanggil (lihat bot.js) walau saldo wallet & stok live sebenarnya ada,
// dan saldo user (lokal) memang benar tidak terpotong (order dibatalkan
// otomatis) - tapi buyer tidak pernah bisa checkout produk Canboso sama
// sekali.
// Fix: generate 1 UUID v4 (36 char, dalam rentang 8-128 yang disyaratkan)
// per pemanggilan pakai crypto.randomUUID() bawaan Node, dikirim sebagai
// header `Idempotency-Key`. Boleh dioverride lewat extra.idempotencyKey
// (mis. kalau suatu saat pemanggil perlu retry request YANG SAMA persis
// tanpa risiko dobel-charge di sisi Canboso - idempotency key yang sama
// akan dianggap request yang sama oleh API); key ini dikeluarkan dulu
// dari `extra` supaya tidak ikut ke-mix ke body request.
// ===== BUG FIX #2 (dikonfirmasi dari dokumentasi Swagger resmi Canboso,
// dikirim user via screenshot): skema respons SUKSES yang sebenarnya BUKAN
// field datar di top-level seperti dugaan lama (order_id/items/accounts
// langsung) - melainkan dibungkus 2 object terpisah:
//   { success, order: { orderCode, status, productId, quantity,
//       bonusQuantity, finalQuantity, ... },
//     payment: { amount, currency, balance, ... },
//     delivery: { accounts: [ ...akun/kode hasil pembelian... ] } }
// Order ID ada di `order.orderCode` (BUKAN order_id/orderId/id di
// top-level), dan item yang dikirim ada di `delivery.accounts` (BUKAN
// `accounts`/`items` di top-level). Ini persis penyebab kasus nyata: order
// SUKSES (saldo Canboso kepotong, dikonfirmasi lewat 🐞 raw response yang
// sudah dipasang sebelumnya) tapi bot selalu gagal mengekstrak apapun.
// Docs juga mengonfirmasi request body WAJIB menyertakan field `key` (buyer
// key) selain product_id/quantity - sebelumnya tidak pernah dikirim di body
// (cuma lewat header Authorization/X-API-Key), jadi ditambahkan di sini.
async function purchase(productId, quantity = 1, extra = {}) {
  const { idempotencyKey, ...bodyExtra } = extra;
  const key = idempotencyKey || crypto.randomUUID();
  const body = { key: CANBOSO_API_KEY, product_id: productId, quantity, ...bodyExtra };

  // ===== BUG FIX #3: request /purchase yang TIMEOUT (lihat fetchWithTimeout,
  // 15 detik) TIDAK BOLEH langsung dianggap "gagal total" - bisa saja
  // response-nya lambat justru KARENA Canboso sudah selesai memproses di sisi
  // mereka (saldo wallet & stok remote SUDAH terpotong), cuma balasannya yang
  // belum sempat sampai sebelum timeout kita habis. Kalau ini terjadi dan
  // pemanggil (bot.js) menganggapnya gagal & tidak mencoba lagi, produk yang
  // sudah terlanjur dibeli itu HILANG begitu saja - tidak ada buyer yang
  // menerimanya, tidak ada catatan order, padahal saldo Canboso kita sudah
  // ke sedot.
  // Fix: docs Canboso menjamin retry dengan Idempotency-Key YANG SAMA PERSIS
  // akan mengembalikan response ASLI (bukan memproses ulang/dobel-charge) -
  // jadi begitu percobaan pertama timeout, aman untuk coba SEKALI lagi
  // pakai key yang identik untuk mengambil hasil sebenarnya, alih-alih
  // langsung menyerah dan melempar error ke pemanggil.
  let json;
  try {
    json = await apiRequest('POST', '/api/v2/telegram-buyer/purchase', {
      body, headers: { 'Idempotency-Key': key }
    });
  } catch (err) {
    // Deteksi timeout secara longgar (bukan HTTP error biasa dari Canboso,
    // yang selalu punya pesan spesifik seperti "Wallet balance is not
    // enough" / "Invalid API key" dll) - hanya kasus network/timeout yang
    // aman & masuk akal untuk di-retry pakai Idempotency-Key yang sama.
    if (!/timeout/i.test(err.message)) throw err;
    console.error(`Canboso purchase timeout (product_id=${productId}, idempotency-key=${key}) - retry sekali dengan key yang sama...`);
    json = await apiRequest('POST', '/api/v2/telegram-buyer/purchase', {
      body, headers: { 'Idempotency-Key': key }
    });
  }

  const order = (json && typeof json.order === 'object' && json.order) ? json.order : {};
  const delivery = (json && typeof json.delivery === 'object' && json.delivery) ? json.delivery : {};

  // Lokasi UTAMA sesuai docs: delivery.accounts. Kandidat lama (top-level/
  // json.data) dipertahankan sebagai FALLBACK saja - kalau-kalau ada tipe
  // produk lain (mis. productType bukan "account") yang membungkus beda.
  let items = pick(delivery, ['accounts', 'items', 'products', 'codes', 'result']);
  if (!Array.isArray(items)) {
    const payload = (json && typeof json.data === 'object' && json.data) ? json.data : json;
    items = pick(payload, ['items', 'products', 'codes', 'accounts', 'result']);
  }
  if (!Array.isArray(items)) {
    const single = pick(delivery, ['code', 'account', 'license', 'link', 'content']);
    items = single !== undefined ? [single] : [];
  }
  // Tiap akun kemungkinan berupa OBJECT (mis. {username, password} atau
  // {email, password, profile}), bukan string tunggal - diformat jadi teks
  // "key: value" per baris supaya langsung terbaca & bisa diteruskan ke
  // buyer apa adanya, bukan dump JSON mentah yang berantakan.
  items = items.map(it => {
    if (typeof it === 'string') return it;
    if (it && typeof it === 'object') {
      return Object.entries(it).map(([k, v]) => `${k}: ${v}`).join('\n');
    }
    return JSON.stringify(it);
  });

  return {
    orderId: pick(order, ['orderCode', 'order_id', 'orderId', 'id'], null),
    items,
    raw: json
  };
}

module.exports = {
  CANBOSO_API_KEY,
  CANBOSO_BASE_URL,
  getProducts,
  getProductsCached,
  getLiveStock,
  getRawProducts,
  purchase
};
