// ============================================================
// payment.js — Integrasi pembayaran otomatis
//
// 1) QRIS lewat PayKita (pay.digikita.id)
// 2) USDT jaringan BEP20 (BNB Smart Chain) lewat monitoring on-chain
//    LANGSUNG ke RPC node BSC publik (JSON-RPC eth_getLogs) - BUKAN lewat
//    BscScan/Etherscan API lagi. Etherscan sekarang mengunci akses gratis
//    ke chain BNB/Base/Avalanche/OP di balik paywall berbayar (Lite $49/bln),
//    jadi kita baca langsung dari blockchain-nya - gratis selamanya, tanpa
//    API key, tanpa rate limit ketat, dan tidak akan kena paywall lagi.
//
// ⚠️ CATATAN soal bagian QRIS/PayKita:
// Field response create-order sudah dikonfirmasi dari payload asli (lihat
// contoh error log): field QR payload EMV bernama "qris" (string mentah,
// bukan URL gambar), nominal PERSIS yang harus dibayar ada di "pay_amount"
// (= base_amount + unique_code), dan ada juga "checkout_url" (link halaman
// bayar hosted PayKita) yang bisa dipakai sebagai fallback/tombol tambahan.
// PENTING: base_amount yang dikirim ke PayKita HARUS dalam Rupiah (IDR) -
// QRIS di Indonesia cuma bisa nominal Rupiah, jadi bot.js wajib mengonversi
// nominal USD ke IDR dulu sebelum memanggil paykitaCreateOrder().
//
// Kode di bawah tetap DEFENSIF (masih nyoba beberapa nama field alternatif)
// untuk jaga-jaga kalau PayKita mengubah nama field di masa depan. Endpoint
// cek status BELUM terverifikasi persis (dokumentasi resmi butuh login
// dashboard), jadi masih coba beberapa path umum berurutan di
// STATUS_PATH_CANDIDATES - sesuaikan di situ kalau ternyata tidak ada yang
// cocok setelah live.
// ============================================================

require('dotenv').config();
const crypto = require('crypto');

// Semua fetch() ke API luar WAJIB lewat sini, bukan fetch() polos. Tanpa
// timeout, request yang hang (API luar lambat/nge-freeze tanpa response)
// bisa nggantung TANPA BATAS WAKTU - ini yang bikin polling deposit
// (USDT/TON/QRIS) rawan overlap antar tick dan saldo user ke-credit dobel.
// Default 15 detik, cukup longgar untuk API on-chain tapi tetap jauh lebih
// pendek dari interval polling-nya sendiri (20-30 detik).
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

const PAYKITA_API_BASE = process.env.PAYKITA_API_BASE || 'https://paykita.biz.id';
const PAYKITA_API_KEY = process.env.PAYKITA_API_KEY || '';

const USDT_BEP20_ADDRESS = process.env.USDT_BEP20_ADDRESS || '';
const USDT_BEP20_CONTRACT = process.env.USDT_BEP20_CONTRACT || '0x55d398326f99059fF775485246999027B3197955'; // USDT resmi di BSC mainnet

// RPC node BSC publik - GRATIS, tanpa API key. Dicoba berurutan (fallback
// ke endpoint berikutnya kalau satu gagal/down/rate-limit) supaya lebih
// tahan banting daripada cuma andalkan 1 provider. Bisa dioverride penuh
// lewat .env (pisah pakai koma) kalau mau pakai RPC pribadi (mis. Ankr
// dengan API key sendiri, atau node sendiri) untuk keandalan lebih tinggi.
// Urutan sengaja ditaruh publicnode & ankr duluan - keduanya masih dukung
// eth_getLogs untuk publik. bsc-dataseed.* ditaruh paling belakang karena
// eth_getLogs SUDAH DIMATIKAN PERMANEN di node itu (selalu balas error
// -32005 "limit exceeded"), jadi taruh di belakang supaya tidak buang waktu
// nyoba dia duluan tiap polling - endpoint itu cuma dipakai sebagai
// fallback terakhir untuk method lain (eth_blockNumber, dst) kalau yang
// lain kebetulan lagi down semua.
// ===== BUG FIX v10: dari 5 RPC publik yang dicoba, cuma bsc.publicnode.com
// yang MASIH beneran bisa dipakai buat eth_getLogs. Sisanya sudah mati:
// - rpc.ankr.com/bsc: SEKARANG WAJIB API key ("Unauthorized: You must
//   authenticate your request with an API key") - dulu gratis tanpa key,
//   sekarang tidak lagi.
// - bsc-dataseed1.defibit.io & bsc-dataseed1.ninicoin.io &
//   bsc-dataseed.binance.org: SEMUA balas -32005 "limit exceeded" untuk
//   eth_getLogs apa pun rentang bloknya (bukan soal jumlah request kita -
//   sudah dikonfirmasi manual lewat curl langsung dari server, hasilnya
//   sama persis walau cuma request TUNGGAL).
// Sebelumnya bot tetap nyoba ke-4 RPC mati ini dulu (satu-satu, masing2
// nunggu timeout/respons gagal) SEBELUM akhirnya nyampe ke publicnode yang
// beneran jalan - buang2 waktu & bikin makin gampang kelewat window
// deposit. Sekarang cuma publicnode yang dipakai untuk eth_getLogs by
// default. Kalau nanti publicnode juga mulai bermasalah, ganti/tambah lewat
// BSC_RPC_URL di .env (pisah pakai koma) - misal daftar Ankr API key gratis
// sendiri di https://www.ankr.com/rpc/ lalu isi URL dengan key-nya di situ.
const BSC_RPC_URLS = (
  process.env.BSC_RPC_URL ||
  'https://bsc.publicnode.com'
).split(',').map(s => s.trim()).filter(Boolean);

// TON / Toncoin (The Open Network) - dipantau otomatis lewat TonCenter API
// (https://toncenter.com), gratis & tanpa API key (rate limit lebih longgar
// kalau isi TONCENTER_API_KEY - daftar gratis di https://toncenter.com/api-key).
const TON_ADDRESS = process.env.TON_ADDRESS || '';
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY || '';
const TONCENTER_API_BASE = process.env.TONCENTER_API_BASE || 'https://toncenter.com/api/v2';

// Binance Pay (C2C transfer ke Binance ID pribadi) - dipantau otomatis lewat
// endpoint RESMI Binance "Get Pay Trade History" (USER_DATA, API KEY BIASA,
// BUKAN Merchant API - lihat catatan lengkap di config.js).
const BINANCE_API_KEY = process.env.BINANCE_API_KEY || '';
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET || '';
const BINANCE_PAY_ID = process.env.BINANCE_PAY_ID || '';
const BINANCE_API_BASE = process.env.BINANCE_API_BASE || 'https://api.binance.com';

// ===================== Kurs USD -> IDR (live, dengan cache) =====================
// Dipakai khusus untuk hitung nominal QRIS (QRIS di Indonesia cuma bisa
// Rupiah). Saldo Wallet toko ini secara konsep 1:1 ke USDT (sama seperti
// alur topup USDT BEP20 di bawah), jadi kursnya diambil dari HARGA PASAR
// LIVE USDT/IDR di CoinGecko - bukan dari kurs forex resmi (open.er-api.com)
// seperti sebelumnya - supaya nominal QRIS yang diminta ke buyer merefleksikan
// harga USDT yang beneran berlaku, bukan kurs bank/forex yang bisa beda cukup
// jauh dari harga pasar kripto. Di-cache 5 menit (sama seperti getTonToUsdRate()
// di bawah - harga kripto lebih fluktuatif daripada kurs fiat, jadi cache-nya
// sengaja lebih pendek dari yang dulu 1 jam) supaya tidak nge-fetch tiap kali
// user mau topup, dan kalau API-nya lagi down/timeout, otomatis fallback ke
// kurs cache terakhir yang masih ada, atau ke nilai default (fallbackRate)
// kalau belum pernah berhasil fetch sama sekali sejak bot nyala.
const RATE_API_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=idr';
const RATE_CACHE_MS = 5 * 60 * 1000; // 5 menit
let cachedRate = null;
let cachedRateAt = 0;

async function getUsdToIdrRate(fallbackRate) {
  const now = Date.now();
  if (cachedRate && (now - cachedRateAt) < RATE_CACHE_MS) {
    return cachedRate;
  }
  try {
    const res = await fetchWithTimeout(RATE_API_URL);
    const json = await res.json();
    const price = json && json.tether && json.tether.idr;
    if (typeof price === 'number' && price > 0) {
      cachedRate = price;
      cachedRateAt = now;
      return cachedRate;
    }
  } catch (err) {
    console.error('Gagal ambil harga live USDT/IDR (CoinGecko):', err.message);
  }
  // Fetch gagal: pakai cache lama kalau ada (biar lebih akurat daripada
  // fallback statis), kalau belum pernah ada cache sama sekali baru pakai fallback.
  return cachedRate || fallbackRate;
}

// Versi SYNC dari kurs USD->IDR, dipakai di tempat yang tidak bisa/mau
// 'await' (mis. fungsi format harga usd() di bot.js yang dipanggil di
// tengah-tengah template string). Pakai cache yang sama dengan versi async
// di atas - kalau cache belum pernah terisi (baru start bot & belum ada
// yang trigger getUsdToIdrRate() sekali pun), balikin fallback statis.
// TIDAK melakukan fetch baru sendiri, jadi tidak pernah lebih "stale" dari
// cache yang sudah ada.
function getCachedUsdToIdrRate(fallbackRate) {
  return cachedRate || fallbackRate;
}

// ===================== Kurs TON -> USD (live, dengan cache) =====================
// Dipakai untuk hitung berapa TON yang setara dengan nominal USD yang diminta
// user saat topup TON. Diambil dari CoinGecko (gratis, tanpa API key),
// di-cache 5 menit (harga TON lebih fluktuatif daripada kurs fiat USD/IDR).
const TON_RATE_API_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd';
const TON_RATE_CACHE_MS = 5 * 60 * 1000; // 5 menit
let cachedTonRate = null;
let cachedTonRateAt = 0;

async function getTonToUsdRate(fallbackRate) {
  const now = Date.now();
  if (cachedTonRate && (now - cachedTonRateAt) < TON_RATE_CACHE_MS) {
    return cachedTonRate;
  }
  try {
    const res = await fetchWithTimeout(TON_RATE_API_URL);
    const json = await res.json();
    const price = json && json['the-open-network'] && json['the-open-network'].usd;
    if (price) {
      cachedTonRate = price;
      cachedTonRateAt = now;
      return cachedTonRate;
    }
  } catch (err) {
    console.error('Gagal ambil kurs TON/USD live:', err.message);
  }
  return cachedTonRate || fallbackRate;
}

// ===================== QRIS (PayKita) =====================

// Kemungkinan nama field di response create-order yang mengandung QR.
// Dicoba satu-satu (termasuk nested di dalam `data`).
function pickField(obj, candidates) {
  for (const key of candidates) {
    if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

async function paykitaCreateOrder(baseAmount, reference) {
  if (!PAYKITA_API_KEY) {
    throw new Error('PAYKITA_API_KEY belum diisi di .env');
  }
  const res = await fetchWithTimeout(`${PAYKITA_API_BASE}/api/orders`, {
    method: 'POST',
    headers: {
      'x-api-key': PAYKITA_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ base_amount: baseAmount, reference })
  });

  let raw;
  try {
    raw = await res.json();
  } catch (e) {
    throw new Error(`PayKita create order: response bukan JSON (HTTP ${res.status})`);
  }

  if (!res.ok) {
    throw new Error(`PayKita create order gagal (HTTP ${res.status}): ${JSON.stringify(raw)}`);
  }

  // Response biasanya { data: {...} } atau langsung object-nya - handle 2-2nya
  const data = raw.data || raw.order || raw;

  const orderId = pickField(data, ['id', 'order_id', 'orderId', 'reference']);
  // Dikonfirmasi dari response asli PayKita: field QR string bernama "qris"
  // (payload EMV QRIS mentah, bukan URL gambar). Kandidat lain dipertahankan
  // sebagai fallback kalau PayKita ganti nama field di masa depan.
  const qrString = pickField(data, ['qris', 'qr_string', 'qris_string', 'qr_content', 'qris_content', 'qrString']);
  const qrImage = pickField(data, ['qr_image', 'qris_image', 'image_url', 'qr_url', 'qrImageUrl']);
  const checkoutUrl = pickField(data, ['checkout_url', 'checkoutUrl']);
  // Dikonfirmasi dari response asli: "pay_amount" adalah nominal PERSIS yang
  // harus dibayar (base_amount + unique_code) - ini yang wajib dipakai untuk
  // ditampilkan ke user, bukan base_amount yang diminta di awal.
  const finalAmount = pickField(data, ['pay_amount', 'amount', 'final_amount', 'total_amount', 'unique_amount']) || baseAmount;
  const status = String(pickField(data, ['status']) || 'PENDING').toUpperCase();

  if (!orderId) {
    throw new Error('PayKita create order: tidak menemukan order id di response. Payload asli: ' + JSON.stringify(raw));
  }
  if (!qrString && !qrImage && !checkoutUrl) {
    throw new Error('PayKita create order: tidak menemukan data QR di response. Payload asli: ' + JSON.stringify(raw));
  }

  return { orderId, qrString, qrImage, checkoutUrl, finalAmount, status, raw };
}

// Endpoint cek status BELUM bisa dipastikan tanpa login dashboard, jadi kita
// coba beberapa kemungkinan path umum secara berurutan sampai ada yang
// berhasil dan mengandung field status yang dikenali.
const STATUS_PATH_CANDIDATES = (orderId) => ([
  `/api/orders/${orderId}`,
  `/api/orders/${orderId}/status`,
  `/api/order/${orderId}`,
  `/api/orders?id=${orderId}`
]);

async function paykitaGetOrderStatus(orderId) {
  if (!PAYKITA_API_KEY) {
    throw new Error('PAYKITA_API_KEY belum diisi di .env');
  }
  let lastErr;
  for (const path of STATUS_PATH_CANDIDATES(orderId)) {
    try {
      const res = await fetchWithTimeout(`${PAYKITA_API_BASE}${path}`, {
        headers: { 'x-api-key': PAYKITA_API_KEY }
      });
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status} di ${path}`); continue; }
      const raw = await res.json().catch(() => null);
      if (!raw) { lastErr = new Error(`Response bukan JSON di ${path}`); continue; }
      const data = raw.data || raw.order || raw;
      const status = String(pickField(data, ['status']) || '').toUpperCase();
      if (!status) { lastErr = new Error(`Tidak ada field status di ${path}`); continue; }
      const paid = ['PAID', 'SUCCESS', 'SUCCEEDED', 'COMPLETED', 'SETTLED'].includes(status);
      return { status, paid, raw };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Semua endpoint cek status PayKita gagal.');
}

// ===================== USDT BEP20 (on-chain, via RPC node BSC langsung) =====================
// Baca event Transfer(address,address,uint256) dari kontrak resmi USDT-BEP20
// langsung dari blockchain (JSON-RPC eth_getLogs) - gratis, tanpa API key,
// tanpa tergantung BscScan/Etherscan.

// ===== BUG FIX v13: v12 (curl via child_process) TERNYATA MASIH 403,
// padahal curl MANUAL di terminal (persis di saat yang sama, IP yang sama)
// tetap 200. Bedanya: v12 kirim body lewat STDIN (`--data-binary @-`) -
// karena curl baca dari pipe (bukan file/string biasa), curl TIDAK TAHU
// panjang datanya dari awal, jadi otomatis pakai header
// "Transfer-Encoding: chunked" alih-alih "Content-Length" yang normal.
// Request ber-chunked buat payload sekecil ini adalah pola TIDAK LAZIM
// untuk request RPC biasa - kemungkinan besar inilah yang bikin proteksi
// anti-bot Cloudflare-nya publicnode curiga & nge-block, beda dari test
// manual kamu yang pakai `-d '...'` (curl tahu persis panjangnya, kirim
// Content-Length normal seperti request pada umumnya).
// Fix: kirim body LANGSUNG sebagai argumen `-d` (bukan lewat stdin/pipe),
// SAMA PERSIS seperti cara kamu tes manual di terminal. Karena dipanggil
// lewat execFile (BUKAN exec/shell), argumen ini tidak lewat shell sama
// sekali, jadi aman dari masalah escaping tanda kutip dsb walau isinya
// JSON kompleks - execFile kirim tiap argumen apa adanya ke curl.
const { execFile } = require('child_process');

function curlJsonRpcPost(url, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
    const payload = JSON.stringify(bodyObj);
    execFile('curl', [
      '-s', // silent, jangan tampilkan progress bar
      '-m', String(timeoutSec), // timeout total request (detik)
      '-X', 'POST',
      '-H', 'content-type: application/json',
      '-w', '\n%{http_code}', // tempel kode HTTP di baris terakhir output
      '-d', payload, // body langsung sebagai argumen (Content-Length normal, sama seperti test manual)
      url
    ], { maxBuffer: 1024 * 1024 * 20, timeout: timeoutMs + 5000 }, (err, stdout, stderr) => {
      // err di sini cuma soal proses curl-nya gagal dijalankan/timeout -
      // BUKAN soal isi respons HTTP (itu tetap dicek lewat status code di
      // pemanggil, lewat stdout yang tetap ada meski curl exit code != 0
      // pada beberapa kasus HTTP error).
      if (err && !stdout) {
        return reject(new Error(`curl gagal dijalankan (${url}): ${stderr || err.message}`));
      }
      const idx = stdout.lastIndexOf('\n');
      const respBody = idx >= 0 ? stdout.slice(0, idx) : stdout;
      const statusStr = idx >= 0 ? stdout.slice(idx + 1).trim() : '';
      const status = parseInt(statusStr, 10) || 0;
      resolve({ status, body: respBody });
    });
  });
}

// Kirim 1 request JSON-RPC (atau batch array) ke RPC endpoint, coba
// berurutan sampai salah satu berhasil.
//
// PENTING: sebagian node publik (terutama bsc-dataseed.binance.org) sudah
// MEMATIKAN eth_getLogs secara permanen, tapi tetap balas HTTP 200 dengan
// body berisi JSON-RPC error ({error:{code:-32005,message:"limit exceeded"}}).
// Kalau kita cuma cek res.ok (status HTTP), response error semacam ini
// dianggap "berhasil" dan langsung dikembalikan tanpa pernah nyoba endpoint
// lain di daftar - makanya sebelumnya selalu stuck di bsc-dataseed. Jadi di
// sini errornya dicek juga di level JSON-RPC, bukan cuma HTTP, sebelum
// pindah ke endpoint berikutnya.
async function bscRpcRequest(body) {
  let lastErr;
  for (const url of BSC_RPC_URLS) {
    try {
      const { status, body: rawBody } = await curlJsonRpcPost(url, body, 10000);
      if (status < 200 || status >= 300) { lastErr = new Error(`RPC HTTP ${status} (${url})`); continue; }
      let json;
      try {
        json = JSON.parse(rawBody);
      } catch (e) {
        lastErr = new Error(`RPC response bukan JSON (${url})`);
        continue;
      }
      // Request tunggal (bukan batch) yang balas error JSON-RPC -> anggap
      // gagal, coba endpoint berikutnya (bukan langsung return).
      if (!Array.isArray(json) && json && json.error) {
        lastErr = new Error(`RPC ${body.method || 'batch'} error (${url}): ${json.error.message}`);
        continue;
      }
      return json;
    } catch (err) {
      lastErr = err;
      continue; // coba RPC endpoint berikutnya
    }
  }
  throw lastErr || new Error('Semua RPC endpoint BSC gagal diakses.');
}

async function bscRpcCall(method, params) {
  const json = await bscRpcRequest({ jsonrpc: '2.0', id: 1, method, params });
  if (json.error) throw new Error(`RPC ${method} error: ${json.error.message}`);
  return json.result;
}

// Batch beberapa request RPC jadi 1 HTTP call (lebih hemat & cepat daripada
// 1 request per blok saat perlu ambil timestamp banyak blok sekaligus).
async function bscRpcBatchCall(requests) {
  if (requests.length === 0) return [];
  const body = requests.map((r, i) => ({ jsonrpc: '2.0', id: i, method: r.method, params: r.params }));
  const json = await bscRpcRequest(body);
  if (!Array.isArray(json)) throw new Error('RPC batch: response bukan array (kemungkinan endpoint tidak dukung batch)');
  const byId = {};
  json.forEach(item => { byId[item.id] = item; });
  return requests.map((_, i) => (byId[i] && !byId[i].error) ? byId[i].result : null);
}

const TRANSFER_EVENT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Ubah address jadi format topic 32-byte (left-padded dengan nol) sesuai
// spesifikasi event log Ethereum/BSC.
function addressToTopic(address) {
  return '0x' + '0'.repeat(24) + address.toLowerCase().replace(/^0x/, '');
}

// Konversi hex wei (string "0x...") ke angka desimal dengan presisi penuh
// pakai BigInt (Number(BigInt) langsung akan kehilangan presisi untuk angka
// besar, jadi digeser desimalnya secara manual lewat string).
function hexWeiToDecimal(hex, decimals) {
  const big = BigInt(hex);
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = big / divisor;
  const frac = (big % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return parseFloat(frac ? `${whole}.${frac}` : `${whole}`);
}

// Banyak RPC publik (bsc-dataseed, ankr, publicnode, dst) menolak
// eth_getLogs kalau rentang blok terlalu lebar (biasanya cuma diizinkan
// ~1000-2000 blok sekaligus) dengan error "limit exceeded" - jadi kita
// pecah requestnya jadi beberapa chunk kecil dan gabung hasilnya, bukan
// 1 request besar yang pasti ditolak semua node.
const MAX_BLOCKS_PER_CALL = 900;

async function fetchLogsChunk(fromBlockNum, toBlockNum) {
  return await bscRpcCall('eth_getLogs', [{
    address: USDT_BEP20_CONTRACT,
    fromBlock: '0x' + fromBlockNum.toString(16),
    toBlock: '0x' + toBlockNum.toString(16),
    // topics[1] (from) dibiarkan null (siapa saja pengirimnya), topics[2]
    // (to) di-filter persis ke wallet kita - jadi RPC-nya sendiri yang
    // nyaring, bukan kita yang filter manual di JS dari semua transfer USDT.
    topics: [TRANSFER_EVENT_TOPIC, null, addressToTopic(USDT_BEP20_ADDRESS)]
  }]);
}

// ===== BUG FIX: RANGE_BLOCKS dulu di-hardcode 3000 dengan asumsi block time
// BSC ~3 detik (~2,5 jam cakupan) - jauh lebih lebar dari masa berlaku
// deposit USDT (30 menit), TERLIHAT aman. TAPI asumsi block time itu sudah
// BASI: BSC sudah lewat 3x hardfork yang mempercepat block time (Lorentz
// April 2025: 3s->1.5s, Maxwell Juni 2025: 1.5s->0.75s, Fermi Januari 2026:
// 0.75s->0.45s). Dengan block time SEKARANG (~0.45 detik), 3000 blok cuma
// mencakup ±22,5 MENIT - LEBIH PENDEK dari 30 menit masa berlaku deposit!
// Efeknya: kalau buyer transfer di awal window lalu ada tick polling yang
// telat/gagal (RPC publik lambat/rate-limit sesaat), begitu transaksinya
// "keluar" dari 22,5 menit terakhir, transaksi itu TIDAK PERNAH ketemu lagi
// walau deposit masih 'pending' sampai menit ke-30 - deposit berakhir
// 'expired' padahal buyer SUDAH transfer & dana sudah masuk on-chain.
// Fix: hitung block time SECARA LIVE tiap kali fetch (bandingkan timestamp
// blok terbaru vs 1000 blok sebelumnya), lalu tentukan jumlah blok yang
// dipindai dari situ (target cakupan 90 menit = 3x masa berlaku deposit,
// jauh lebih aman dari sekadar 2x) - supaya OTOMATIS tetap benar walau BSC
// hardfork lagi mempercepat block time di masa depan, tidak perlu di-tune
// manual tiap kali ada upgrade jaringan seperti sebelumnya. Dibatasi
// (clamp) ke rentang wajar (min 1500, max 20000 blok) supaya kalau hasil
// hitungnya aneh (mis. RPC balas timestamp tidak masuk akal), tetap tidak
// memicu scan yang terlalu sempit ATAU terlalu besar (boros rate limit).
const USDT_COVERAGE_TARGET_SECONDS = 90 * 60; // 90 menit (3x masa berlaku deposit 30 menit)
const BLOCK_TIME_SAMPLE_BLOCKS = 1000;
const MIN_RANGE_BLOCKS = 1500;
const MAX_RANGE_BLOCKS = 20000;

async function estimateRangeBlocks(latest) {
  try {
    const refBlockNum = Math.max(0, latest - BLOCK_TIME_SAMPLE_BLOCKS);
    const [latestBlock, refBlock] = await bscRpcBatchCall([
      { method: 'eth_getBlockByNumber', params: ['0x' + latest.toString(16), false] },
      { method: 'eth_getBlockByNumber', params: ['0x' + refBlockNum.toString(16), false] }
    ]);
    const latestTs = latestBlock ? parseInt(latestBlock.timestamp, 16) : null;
    const refTs = refBlock ? parseInt(refBlock.timestamp, 16) : null;
    const blockDelta = latest - refBlockNum;
    if (latestTs && refTs && latestTs > refTs && blockDelta > 0) {
      const avgBlockTimeSec = (latestTs - refTs) / blockDelta;
      const computed = Math.ceil(USDT_COVERAGE_TARGET_SECONDS / avgBlockTimeSec);
      return Math.min(MAX_RANGE_BLOCKS, Math.max(MIN_RANGE_BLOCKS, computed));
    }
  } catch (err) {
    console.error('Gagal estimasi block time BSC live, pakai fallback:', err.message);
  }
  // Fallback kalau estimasi live gagal (RPC error dsb): pakai asumsi
  // block time TERCEPAT yang sudah dikonfirmasi (0.45s, pasca Fermi) supaya
  // tetap AMAN OVER-cover daripada under-cover kalau harus nebak.
  return Math.ceil(USDT_COVERAGE_TARGET_SECONDS / 0.45);
}

// ===== BUG FIX: setiap deposit USDT pending punya setInterval SENDIRI-SENDIRI
// (lihat pollUsdtDeposit() di bot.js), dan SEBELUM fix ini tiap tick interval
// manapun langsung manggil fetchIncomingUsdtTransfers() dari NOL - yang
// isinya bisa belasan-puluhan request eth_getLogs (RANGE_BLOCKS bisa sampai
// ribuan blok, dipecah per MAX_BLOCKS_PER_CALL=900). Kalau ada 2+ buyer yang
// sama-sama lagi nunggu pembayaran USDT di waktu bersamaan, SEMUA request
// mahal itu KEBAWAH-KE-ATAS ke RPC publik gratis SECARA TERPISAH & REDUNDAN
// (padahal hasilnya SAMA PERSIS, semua nanya transfer ke 1 wallet yang sama)
// - gampang kena rate-limit RPC publik, bikin fetch GAGAL diam-diam (cuma
// ke-log, lihat catch di pollUsdtDeposit), dan pembayaran yang SUDAH masuk
// on-chain jadi TIDAK KEDETEKSI di tick itu - baru mungkin kedeteksi tick
// berikutnya kalau rate-limit-nya reda, atau malah expired duluan kalau
// terus-menerus gagal. Ini penyebab paling mungkin dari keluhan "kadang
// kedeteksi kadang tidak" - BUKAN karena address/kode salah, tapi karena
// beban redundan ke RPC gratis.
// Fix: cache hasil fetch selama CACHE_TTL_MS (di bawah interval polling 20
// detik di bot.js) - kalau ada 2+ deposit yang nge-tick berdekatan, yang
// KEDUA dst tinggal pakai hasil cache, TIDAK fetch ulang dari nol. Ini juga
// otomatis mengurangi total beban ke RPC publik secara keseluruhan.
const USDT_TRANSFERS_CACHE_TTL_MS = 15000;
let usdtTransfersCache = { data: null, fetchedAt: 0, inflight: null };

// ===== BUG FIX v8: SEMUA endpoint RPC publik (termasuk yang tadinya masih
// dukung eth_getLogs - publicnode, ankr, defibit, ninicoin) ikut kena
// "limit exceeded" beruntun, bukan cuma bsc-dataseed. Penyebabnya BUKAN
// rentang blok per-request kelewat lebar (MAX_BLOCKS_PER_CALL=900 sudah
// aman), tapi JUMLAH REQUEST PER TICK POLLING kelewat banyak: dengan block
// time sekarang (~0.45 detik pasca hardfork Fermi) dan target cakupan 90
// menit, RANGE_BLOCKS bisa sampai ~12.000 blok -> DIPECAH jadi ~14 chunk
// eth_getLogs SETIAP kali fetchIncomingUsdtTransfersUncached() dipanggil
// dari NOL - dan ini dipanggil ulang dari nol TIAP TICK (tiap 20 detik,
// cache 15 detik cuma efektif kalau ada 2+ deposit nge-tick nyaris
// berbarengan). ~14 chunk x tiap chunk bisa nyoba sampai 5 RPC berbeda
// kalau yang duluan gagal = beban jauh di atas rate limit gratis provider
// manapun -> SEMUA RPC ikut kena limit, deteksi deposit jadi TOTAL MATI
// (bukan cuma "kadang gagal").
//
// Fix: scan INKREMENTAL. Simpan blok terakhir yang SUKSES di-scan penuh
// (lastScannedBlock) dan transfer yang sudah ketemu sejauh ini. Tick
// berikutnya cuma perlu scan blok BARU sejak lastScannedBlock (biasanya
// cuma puluhan blok dalam 20 detik -> 1 chunk RPC saja), lalu digabung ke
// daftar transfer yang sudah ada (bukan replace dari nol) - bukan diulang
// scan 90 menit penuh tiap tick. Ini memangkas jumlah request eth_getLogs
// per tick dari ~14 chunk jadi ~1 chunk di kondisi normal (turun >90%),
// yang seharusnya menghilangkan akar penyebab rate-limit beruntun ini.
//
// lastScannedBlock CUMA dimajukan SETELAH semua chunk di tick itu sukses -
// kalau ada chunk yang gagal (exception dilempar sebelum sampai baris itu),
// cursor TIDAK maju, jadi tick berikutnya otomatis coba lagi dari titik
// yang sama (tidak ada rentang blok yang "terlewat" gara-gara gagal
// parsial). Kalau bot baru start (lastScannedBlock masih null) atau ada gap
// kegagalan yang kelewat lama (jarak ke `latest` sudah lebih besar dari
// MAX_RANGE_BLOCKS), otomatis fallback ke full backfill scan (perilaku lama)
// supaya tidak ada transfer yang kelewat kedeteksi.
const USDT_SCAN_OVERLAP_BLOCKS = 5; // mundur dikit tiap tick, jaga-jaga reorg tipis
const USDT_TRANSFER_RETENTION_MS = 90 * 60 * 1000; // simpan transfer selama 90 menit (samakan dgn window aman lama)
let usdtScanState = { lastScannedBlock: null, transfers: [] };

async function fetchIncomingUsdtTransfers() {
  if (!USDT_BEP20_ADDRESS) throw new Error('USDT_BEP20_ADDRESS belum diisi di .env');

  const now = Date.now();
  if (usdtTransfersCache.data && (now - usdtTransfersCache.fetchedAt) < USDT_TRANSFERS_CACHE_TTL_MS) {
    return usdtTransfersCache.data;
  }
  // Kalau ada fetch lain yang SEDANG jalan (belum selesai) pas tick lain
  // nyampe hampir bersamaan, ikut nunggu hasil yang sama (bukan mulai fetch
  // baru lagi) - mencegah 2 fetch mahal jalan PARALEL persis di detik yang
  // sama sebelum salah satunya sempat nyimpen ke cache.
  if (usdtTransfersCache.inflight) return usdtTransfersCache.inflight;

  const promise = (async () => {
    const result = await fetchIncomingUsdtTransfersUncached();
    usdtTransfersCache = { data: result, fetchedAt: Date.now(), inflight: null };
    return result;
  })().catch(err => {
    usdtTransfersCache.inflight = null; // gagal - jangan nyangkut, biar tick berikutnya boleh coba fetch baru lagi
    throw err;
  });
  usdtTransfersCache.inflight = promise;
  return promise;
}

async function fetchIncomingUsdtTransfersUncached() {
  const latestHex = await bscRpcCall('eth_blockNumber', []);
  const latest = parseInt(latestHex, 16);

  let fromBlock;
  if (usdtScanState.lastScannedBlock === null) {
    // Belum pernah scan sukses sama sekali (baru start / abis restart) ->
    // full backfill seperti perilaku lama, supaya tidak ada transfer yang
    // sudah masuk sebelum bot nyala jadi kelewat.
    const RANGE_BLOCKS = await estimateRangeBlocks(latest);
    fromBlock = Math.max(0, latest - RANGE_BLOCKS);
  } else {
    fromBlock = Math.max(0, usdtScanState.lastScannedBlock - USDT_SCAN_OVERLAP_BLOCKS);
    // Gap ke `latest` kelewat jauh (mis. gagal terus-menerus lama / bot
    // sempat freeze) -> incremental sudah tidak cukup, balik ke full scan
    // supaya tidak ada rentang yang kelewat kedeteksi.
    if (latest - fromBlock > MAX_RANGE_BLOCKS) {
      const RANGE_BLOCKS = await estimateRangeBlocks(latest);
      fromBlock = Math.max(0, latest - RANGE_BLOCKS);
    }
  }
  if (fromBlock > latest) fromBlock = latest;

  // Pecah [fromBlock, latest] jadi beberapa chunk <= MAX_BLOCKS_PER_CALL
  // supaya tidak kena "limit exceeded" dari RPC publik. Di kondisi normal
  // (incremental) ini biasanya cuma 1 chunk karena fromBlock..latest cuma
  // selisih puluhan blok (~1 tick polling).
  let newLogs = [];
  for (let chunkStart = fromBlock; chunkStart <= latest; chunkStart += MAX_BLOCKS_PER_CALL) {
    const chunkEnd = Math.min(chunkStart + MAX_BLOCKS_PER_CALL - 1, latest);
    const chunkLogs = await fetchLogsChunk(chunkStart, chunkEnd);
    if (Array.isArray(chunkLogs)) newLogs = newLogs.concat(chunkLogs);
  }

  // Baru majukan cursor SETELAH semua chunk di atas sukses (kalau salah
  // satu gagal, exception sudah dilempar duluan dari fetchLogsChunk/
  // bscRpcCall sebelum baris ini kesentuh - cursor tetap di posisi lama).
  usdtScanState.lastScannedBlock = latest;

  if (newLogs.length > 0) {
    // Ambil timestamp tiap blok BARU yang relevan (buat toleransi waktu di
    // bot.js) lewat 1 batch request, bukan 1 request per log.
    const uniqueBlocks = [...new Set(newLogs.map(l => l.blockNumber))];
    const blockResults = await bscRpcBatchCall(uniqueBlocks.map(bn => ({ method: 'eth_getBlockByNumber', params: [bn, false] })));
    const timestampByBlock = {};
    uniqueBlocks.forEach((bn, i) => {
      timestampByBlock[bn] = blockResults[i] ? parseInt(blockResults[i].timestamp, 16) * 1000 : 0;
    });

    const newTransfers = newLogs.map(log => ({
      hash: log.transactionHash,
      // logIndex dipakai buat kunci dedupe unik (bukan buat ditampilkan) -
      // 1 tx bisa punya lebih dari 1 event Transfer ke wallet yang sama.
      _dedupeKey: `${log.transactionHash}-${log.logIndex}`,
      from: '0x' + log.topics[1].slice(-40),
      amount: hexWeiToDecimal(log.data, 18), // USDT di BSC pakai 18 desimal (beda dari Ethereum yang 6)
      timestamp: timestampByBlock[log.blockNumber] || 0,
      blockNumber: parseInt(log.blockNumber, 16)
    }));

    usdtScanState.transfers = usdtScanState.transfers.concat(newTransfers);
  }

  // Buang transfer yang sudah lewat masa berlakunya (di luar retention
  // window) supaya list tidak numpuk terus di memori, dan dedupe (overlap
  // USDT_SCAN_OVERLAP_BLOCKS antar tick bisa bikin log yang sama kebaca 2x).
  const now = Date.now();
  const seen = new Set();
  usdtScanState.transfers = usdtScanState.transfers.filter(t => {
    if (t.timestamp && (now - t.timestamp) > USDT_TRANSFER_RETENTION_MS) return false;
    if (seen.has(t._dedupeKey)) return false;
    seen.add(t._dedupeKey);
    return true;
  });

  return usdtScanState.transfers;
}

// Bikin nominal USDT unik (tambah 0.0001 - 0.0999) supaya tiap deposit yang
// lagi pending punya nominal beda-beda - perlu karena transfer USDT di
// blockchain tidak punya kolom memo/catatan untuk mencocokkan ke user mana.
function generateUniqueUsdtAmount(baseAmount, usedAmounts) {
  let amount;
  let tries = 0;
  do {
    const variant = (Math.floor(Math.random() * 999) + 1) / 10000; // 0.0001 - 0.0999
    amount = Number((baseAmount + variant).toFixed(4));
    tries++;
  } while (usedAmounts.has(amount) && tries < 50);
  return amount;
}

// ===================== TON / Toncoin (on-chain, via TonCenter) =====================
// TonCenter getTransactions mengembalikan histori transaksi 1 alamat wallet,
// termasuk transfer MASUK lewat field in_msg (source terisi = transfer masuk
// dari alamat lain, value dalam nanoton / 1e9 = 1 TON). Sama seperti BscScan,
// tidak butuh HP/aplikasi nyala terus - full berbasis polling API.
async function fetchIncomingTonTransfers() {
  if (!TON_ADDRESS) throw new Error('TON_ADDRESS belum diisi di .env');

  const url = `${TONCENTER_API_BASE}/getTransactions?address=${encodeURIComponent(TON_ADDRESS)}&limit=50&archival=true`;
  const res = await fetchWithTimeout(url, {
    headers: TONCENTER_API_KEY ? { 'X-API-Key': TONCENTER_API_KEY } : {}
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error('TonCenter: response bukan JSON');
  if (json.ok === false) throw new Error('TonCenter error: ' + JSON.stringify(json));

  const list = Array.isArray(json.result) ? json.result : [];
  return list
    .filter(tx => tx.in_msg && tx.in_msg.source && Number(tx.in_msg.value) > 0)
    .map(tx => ({
      hash: tx.transaction_id ? tx.transaction_id.hash : (tx.hash || ''),
      from: tx.in_msg.source,
      amount: Number(tx.in_msg.value) / 1e9,
      timestamp: Number(tx.utime) * 1000
    }));
}

// Bikin nominal TON unik (tambah 0.0001 - 0.0099) supaya tiap deposit yang
// lagi pending punya nominal beda-beda - sama alasannya seperti USDT di atas
// (transfer TON juga tidak wajib punya memo/comment yang bisa diandalkan
// untuk mencocokkan ke user mana). Variasinya sengaja lebih kecil dari USDT
// karena TON per keping lebih mahal - variasi 0.0001-0.0099 TON tetap cukup
// untuk keunikan tanpa terasa besar secara nilai.
function generateUniqueTonAmount(baseAmount, usedAmounts) {
  let amount;
  let tries = 0;
  do {
    const variant = (Math.floor(Math.random() * 99) + 1) / 10000; // 0.0001 - 0.0099
    amount = Number((baseAmount + variant).toFixed(6));
    tries++;
  } while (usedAmounts.has(amount) && tries < 50);
  return amount;
}

// ===================== Binance Pay (C2C, via Get Pay Trade History) =====================
// Dokumentasi resmi: https://developers.binance.com/docs/pay/rest-api
// (endpoint GET /sapi/v1/pay/transactions) - endpoint ini termasuk API BIASA
// (bukan Merchant/khusus bisnis), jadi cukup buat API key dari akun Binance
// pribadi (binance.com -> Profile -> API Management) dengan permission
// "Enable Reading" saja (TIDAK perlu & TIDAK boleh aktifkan permission
// trading/withdraw demi keamanan, fitur ini murni baca histori).
//
// Cara kerja pencocokan pembayaran SAMA PERSIS seperti USDT BEP20/TON di
// atas: karena transfer Binance Pay C2C tidak wajib menyertakan
// memo/catatan yang bisa diandalkan untuk mencocokkan ke user mana, bot.js
// membuatkan NOMINAL UNIK (base amount + variasi kecil) tiap kali user mau
// topup, lalu polling endpoint ini tiap beberapa detik untuk mencari
// transaksi masuk (amount > 0, orderType 'C2C') dengan nominal yang cocok
// persis, dalam rentang waktu setelah deposit dibuat.
function binanceSignQuery(queryString) {
  return crypto.createHmac('sha256', BINANCE_API_SECRET).update(queryString).digest('hex');
}

// ---- Auto-koreksi jam server (fix error -1021 "Timestamp for this request
// is outside of the recvWindow") ----
// Root cause error ini SELALU jam VPS yang drift dari jam server Binance
// (bukan bug logika). Daripada 100% bergantung jam sistem VPS akurat, kita
// hitung SELISIH (offset) antara jam lokal & jam server Binance sekali di
// awal (refresh tiap 30 menit, atau langsung saat kena -1021), lalu offset
// itu ditambahkan ke Date.now() tiap bikin request signed - jadi tetap aman
// walau jam VPS ngaco beberapa detik.
let binanceTimeOffsetMs = 0;
let binanceTimeOffsetFetchedAt = 0;
const BINANCE_TIME_OFFSET_TTL_MS = 30 * 60 * 1000; // refresh tiap 30 menit

async function refreshBinanceTimeOffset() {
  try {
    const localBefore = Date.now();
    const res = await fetchWithTimeout(`${BINANCE_API_BASE}/api/v3/time`);
    const json = await res.json().catch(() => null);
    const localAfter = Date.now();
    if (json && json.serverTime) {
      const localMid = Math.round((localBefore + localAfter) / 2);
      binanceTimeOffsetMs = json.serverTime - localMid;
      binanceTimeOffsetFetchedAt = Date.now();
    }
  } catch (err) {
    // Gagal ambil server time (mis. lagi network blip) - biarkan pakai
    // offset lama, jangan sampai bikin fitur payment lain ikut down.
  }
}

function binanceNow() {
  return Date.now() + binanceTimeOffsetMs;
}

async function binanceSignedGet(path, params = {}) {
  if (!BINANCE_API_KEY || !BINANCE_API_SECRET) throw new Error('BINANCE_API_KEY/BINANCE_API_SECRET belum diisi di .env');
  if (Date.now() - binanceTimeOffsetFetchedAt > BINANCE_TIME_OFFSET_TTL_MS) {
    await refreshBinanceTimeOffset();
  }

  const doRequest = async () => {
    const query = new URLSearchParams({ timestamp: String(binanceNow()), recvWindow: '20000', ...params });
    const signature = binanceSignQuery(query.toString());
    query.append('signature', signature);
    const res = await fetchWithTimeout(`${BINANCE_API_BASE}${path}?${query.toString()}`, {
      headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }
    });
    const json = await res.json().catch(() => null);
    if (!json) throw new Error('Binance API: response bukan JSON');
    // Response error Binance biasa berbentuk { code: -1234 (number, negatif),
    // msg: '...' } - beda dari response sukses endpoint Pay yang code-nya
    // string '000000'. Jadi deteksi error dengan cek code number/negatif,
    // BUKAN cuma "code truthy" (supaya '000000' tidak ketangkep sebagai error).
    if (json.code !== undefined && json.code !== '000000' && Number(json.code) < 0) {
      throw new Error(`Binance API error ${json.code}: ${json.msg || JSON.stringify(json)}`);
    }
    return json;
  };

  try {
    return await doRequest();
  } catch (err) {
    // Kena -1021 (timestamp outside recvWindow)? Refresh offset & retry SEKALI
    // sebelum dianggap benar-benar gagal - ini yang bikin auto-detect Binance
    // Pay tidak lagi macet gara-gara jam VPS drift.
    if (String(err.message).includes('-1021')) {
      await refreshBinanceTimeOffset();
      return await doRequest();
    }
    throw err;
  }
}

// Ambil transaksi Pay MASUK dalam ~2 jam terakhir (cukup lebar dibanding
// masa berlaku 1 deposit yang 30 menit - sama alasannya dengan RANGE_BLOCKS
// di fetchIncomingUsdtTransfers()). startTime/endTime dikirim eksplisit
// walau di bawah limit 90 hari default endpoint ini, supaya hasilnya
// konsisten & tidak tiba-tiba melebar kalau Binance ubah default suatu saat.
async function fetchIncomingBinancePayTransactions() {
  const endTime = Date.now();
  const startTime = endTime - (2 * 60 * 60 * 1000); // 2 jam terakhir
  const json = await binanceSignedGet('/sapi/v1/pay/transactions', { startTime, endTime, limit: 100 });
  const list = Array.isArray(json.data) ? json.data : [];
  return list
    // orderType 'C2C' = transfer personal ke Binance ID (yang dipakai flow
    // ini). 'PAY' (C2B Merchant) sengaja tidak diikutkan karena bot ini
    // TIDAK pakai Merchant API - kalau nanti mau dukung Binance Pay Merchant
    // juga, tambahkan 'PAY' di sini SETELAH pasang integrasi order-create-nya.
    .filter(tx => tx.orderType === 'C2C' && Number(tx.amount) > 0)
    .map(tx => ({
      id: String(tx.transactionId || ''),
      amount: Number(tx.amount),
      currency: tx.currency || '',
      timestamp: Number(tx.transactionTime) || 0
    }));
}

// Bikin nominal unik ala USDT/TON (variasi kecil di belakang koma) supaya
// tiap deposit Binance Pay yang lagi pending punya nominal beda-beda -
// diperlukan karena transfer C2C Binance Pay tidak wajib disertai
// memo/catatan yang bisa diandalkan untuk mencocokkan ke user mana.
function generateUniqueBinanceAmount(baseAmount, usedAmounts) {
  let amount;
  let tries = 0;
  do {
    const variant = (Math.floor(Math.random() * 999) + 1) / 10000; // 0.0001 - 0.0999
    amount = Number((baseAmount + variant).toFixed(4));
    tries++;
  } while (usedAmounts.has(amount) && tries < 50);
  return amount;
}

// Aset yang WAJIB dipakai buyer saat kirim Binance Pay - toko ini mematok
// saldo Wallet 1:1 ke USD/USDT (sama seperti USDT BEP20 di atas), jadi
// pembayaran WAJIB dalam USDT, bukan aset lain apapun.
const BINANCE_EXPECTED_CURRENCY = 'USDT';

// Diagnostik khusus (BUKAN untuk auto-credit): ambil transaksi Pay MASUK di
// rentang waktu tertentu TANPA filter currency/orderType ketat seperti
// fetchIncomingBinancePayTransactions() di atas. Dipakai waktu sebuah
// deposit expired tanpa ketemu match, supaya admin langsung lihat di
// notifikasi Telegram apa saja transaksi yang sebenarnya masuk di jendela
// waktu itu (kalau ada) - kemungkinan besar penyebab "tidak ketemu" adalah
// currency bukan persis USDT, orderType bukan 'C2C' (mis. buyer bayar lewat
// fitur "Pay"/QR bukan "Send" ke Binance ID), atau nominal beda tipis di
// desimal terakhir - tanpa ini admin harus buka app Binance manual dulu
// buat tahu penyebabnya.
async function fetchRawBinancePayTransactionsInRange(startTime, endTime) {
  const json = await binanceSignedGet('/sapi/v1/pay/transactions', { startTime, endTime, limit: 100 });
  const list = Array.isArray(json.data) ? json.data : [];
  return list.map(tx => ({
    id: String(tx.transactionId || ''),
    amount: Number(tx.amount),
    currency: tx.currency || '',
    orderType: tx.orderType || '',
    timestamp: Number(tx.transactionTime) || 0
  }));
}

module.exports = {
  PAYKITA_API_KEY,
  USDT_BEP20_ADDRESS,
  USDT_BEP20_CONTRACT,
  TON_ADDRESS,
  TONCENTER_API_KEY,
  BINANCE_API_KEY,
  BINANCE_API_SECRET,
  BINANCE_PAY_ID,
  getUsdToIdrRate,
  getCachedUsdToIdrRate,
  paykitaCreateOrder,
  paykitaGetOrderStatus,
  fetchIncomingUsdtTransfers,
  generateUniqueUsdtAmount,
  getTonToUsdRate,
  fetchIncomingTonTransfers,
  generateUniqueTonAmount,
  fetchIncomingBinancePayTransactions,
  fetchRawBinancePayTransactionsInRange,
  generateUniqueBinanceAmount,
  BINANCE_EXPECTED_CURRENCY
};
