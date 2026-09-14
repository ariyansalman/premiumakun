// ============================================================
// supplier.js — Integrasi API "Supplier" (https://aiversehub.store)
// ============================================================
// Dipakai untuk fitur "Supplier API": toko ini bisa menghubungkan salah
// satu varian produk lokal ke sebuah `service_id` di Supplier. Begitu ada
// buyer beli varian yang terhubung, bot memesan produknya SECARA OTOMATIS
// lewat API (bukan dari stok lokal `stockItems`) dan langsung meneruskan
// kode/link yang dibalas API itu ke buyer - mirip dropship otomatis.
//
// Dokumentasi resmi: https://aiversehub.store/docs
// Auth: header "X-API-Key: <key>" di setiap request.
// Rate limit: 3 request/detik per API key (balasan 429 kalau kelebihan).
// ============================================================

require('dotenv').config();

const AIVERSEHUB_API_KEY = process.env.AIVERSEHUB_API_KEY || '';
const AIVERSEHUB_BASE_URL = (process.env.AIVERSEHUB_BASE_URL || 'https://aiversehub.store').replace(/\/+$/, '');

// Sama seperti fetchWithTimeout() di payment.js - tanpa timeout, request yang
// hang (API supplier lambat/nge-freeze) bisa bikin proses pembelian user
// nge-gantung tanpa batas waktu (dan tombol "Place Order" kelihatan macet).
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
  if (!AIVERSEHUB_API_KEY) {
    throw new Error('AIVERSEHUB_API_KEY belum diisi di .env');
  }
}

// Request generik ke API Supplier. `query` (object) opsional untuk GET
// dengan query string. Melempar Error dengan pesan yang jelas untuk semua
// kegagalan (network, timeout, HTTP non-2xx, rate limit, JSON tidak valid)
// supaya pemanggil tinggal try/catch tanpa perlu ngecek status manual lagi.
async function apiRequest(method, path, { query, body } = {}) {
  ensureConfigured();
  let url = `${AIVERSEHUB_BASE_URL}${path}`;
  if (query && Object.keys(query).length) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
    ).toString();
    if (qs) url += `?${qs}`;
  }

  const res = await fetchWithTimeout(url, {
    method,
    headers: {
      'X-API-Key': AIVERSEHUB_API_KEY,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  if (res.status === 429) {
    throw new Error('Supplier: rate limit tercapai (429 Too Many Requests), coba lagi sebentar lagi.');
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error(`Supplier: response bukan JSON (HTTP ${res.status}) di ${path}`);
  }

  if (!res.ok) {
    const msg = (json && (json.error || json.message)) || `HTTP ${res.status}`;
    throw new Error(`Supplier API error di ${path}: ${msg}`);
  }

  return json;
}

// GET /api/v1/me - profil & saldo wallet toko kita DI SISI Supplier
// (bukan saldo Wallet buyer di bot ini - dua hal yang beda).
async function getMe() {
  return apiRequest('GET', '/api/v1/me');
}

// GET /api/v1/products - daftar semua service/produk yang tersedia di
// Supplier beserta harga & stok real-time mereka. Return array kosong
// kalau field `services` tidak ada di response (jaga-jaga format berubah).
async function getProducts() {
  const json = await apiRequest('GET', '/api/v1/products');
  return Array.isArray(json.services) ? json.services : [];
}

// POST /api/v1/order - pesan otomatis. Return { order_id, total_cost,
// new_balance, products } persis seperti struktur di docs kalau sukses -
// melempar Error (lihat apiRequest) kalau gagal (mis. saldo Supplier kita
// habis, atau stok remote kosong).
async function placeOrder(serviceId, quantity) {
  return apiRequest('POST', '/api/v1/order', { body: { service_id: serviceId, quantity } });
}

// GET /api/v1/order/{id} - detail 1 order (dipakai untuk audit/debug manual
// dari /admin kalau perlu re-cek status order tertentu di sisi Supplier).
async function getOrderById(orderId) {
  const json = await apiRequest('GET', `/api/v1/order/${encodeURIComponent(orderId)}`);
  return json && json.order ? json.order : null;
}

// GET /api/v1/orders - riwayat order kita di Supplier (limit maksimum
// yang diizinkan API adalah 200 - dibatasi di sini juga supaya tidak
// bolak-balik dapat error "limit terlalu besar" dari API).
async function getOrders({ page, limit } = {}) {
  const safeLimit = limit ? Math.min(Number(limit), 200) : undefined;
  return apiRequest('GET', '/api/v1/orders', { query: { page, limit: safeLimit } });
}

// GET /api/v1/stats - statistik akun kita di Supplier (total deposit,
// total belanja, breakdown per produk). `start`/`end` opsional, format
// persis sesuai docs: YYYY-MM-DD-HH:MM-AM/PM.
async function getStats({ start, end } = {}) {
  return apiRequest('GET', '/api/v1/stats', { query: { start, end } });
}

module.exports = {
  AIVERSEHUB_API_KEY,
  AIVERSEHUB_BASE_URL,
  getMe,
  getProducts,
  placeOrder,
  getOrderById,
  getOrders,
  getStats
};
