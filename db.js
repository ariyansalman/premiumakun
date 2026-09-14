const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');

// Each variant: { id, label, stock, tiers: [{ min, max|null, price }] }
// tiers are sorted ascending by `min`; the last tier can have max: null (unbounded)
const DEFAULT_DB = {
  users: {},     // chatId -> { username, balance }
  products: [],
  // deposits: topup Wallet via pembayaran otomatis (QRIS PayKita / USDT BEP20).
  // { id, chatId, method: 'qris'|'usdt_bep20', status: 'pending'|'paid'|'expired',
  //   requestedAmount (USD yang masuk ke saldo), createdAt, expiresAt,
  //   -- khusus qris: paykitaOrderId, paykitaReference, finalAmount
  //   -- khusus usdt_bep20: usdtAmount (nominal unik), walletAddress, txHash }
  deposits: [],
  orders: [],    // { id, chatId, productId, variantId, qty, unitPrice, total, createdAt, status }
  pendingAction: {}, // chatId -> { type: '...', data }
  emojiIds: {},  // key (mis. "menu:buy_produk" / "teks:product_desc") -> custom_emoji_id string
  settings: {
    // Auto Backup: zip full source code (kecuali node_modules & .npm)
    // dikirim otomatis ke sebuah group Telegram tiap interval tertentu.
    backup: { enabled: false, intervalMinutes: 60, groupId: null },
    // Wajib Join Channel: user WAJIB join semua channel di daftar ini dulu
    // sebelum bisa pakai menu bot (kalau enabled: true). Tiap channel:
    // { id, title, link, chatRef } - chatRef = @username ATAU chat id numerik
    // (dipakai bot buat cek status join via getChatMember), link = link
    // undangan yang ditampilkan sebagai tombol ke user.
    forceJoin: { enabled: false, channels: [] },
    // Notifikasi Channel Otomatis: tiap ada pembelian produk / topup Wallet
    // sukses (QRIS/USDT/TON), bot otomatis kirim pesan teks + menu inline ke
    // 1 channel/group tujuan ini (kalau enabled: true). chatRef = @username
    // channel ATAU chat id numerik (mis. "-1001234567890") - bot WAJIB sudah
    // jadi admin di channel/group tsb supaya bisa kirim pesan ke sana.
    // notifyPurchase/notifyTopup/notifyReferral masing-masing bisa dimatikan terpisah.
    // notifyMaintenance: kirim juga ke channel ini setiap admin
    // aktif/nonaktifkan Mode Maintenance (lihat sendChannelNotif kind
    // 'maintenance' & buildChannelMaintenanceText() di bot.js).
    channelNotif: { enabled: false, chatRef: null, title: null, notifyPurchase: true, notifyTopup: true, notifyReferral: true, notifyMaintenance: true },
    // Mode Maintenance: kalau enabled true, SEMUA user non-admin diblokir dari
    // seluruh interaksi bot (command, tombol, input teks) dan cuma dikasih
    // lihat pesan maintenance. Admin (ADMIN_IDS) selalu tetap bisa akses
    // normal, supaya owner tidak pernah ikut terkunci dari bot-nya sendiri.
    // message: null -> pakai teks default "keren" (lihat buildMaintenanceText()
    // di bot.js, emoji-nya diambil dari teksEmoji() -> bisa di-custom lewat
    // admin "🎨 Kelola Emoji ID"). Kalau admin isi pesan custom sendiri lewat
    // "✏️ Set Pesan Custom", field ini kepakai apa adanya (termasuk custom
    // emoji premium yang owner pilih langsung saat ngetik, lihat
    // embedOwnerCustomEmoji() di bot.js).
    maintenance: { enabled: false, message: null }
  }
};

function ensureDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2));
  }
}

function readDb() {
  ensureDb();
  let raw = fs.readFileSync(DB_PATH, 'utf-8');
  let db;
  try {
    db = JSON.parse(raw);
  } catch (err) {
    // db.json corrupt (mis. sisa crash sebelum patch atomic-write ini ada).
    // Coba pulih dari db.json.bak (salinan terakhir yang sukses ditulis) -
    // jauh lebih baik daripada bot gagal start total tanpa penjelasan.
    console.error('⚠️ db.json corrupt/tidak valid JSON:', err.message);
    const bakPath = DB_PATH + '.bak';
    if (fs.existsSync(bakPath)) {
      console.error('⚠️ Memulihkan dari db.json.bak...');
      raw = fs.readFileSync(bakPath, 'utf-8');
      db = JSON.parse(raw); // kalau .bak juga corrupt, biar error asli kelihatan
      fs.writeFileSync(DB_PATH, raw);
    } else {
      throw err;
    }
  }
  // Migrasi ringan untuk db.json lama (dari sebelum fitur deposits ada)
  if (!Array.isArray(db.deposits)) db.deposits = [];
  if (!db.emojiIds || typeof db.emojiIds !== 'object') db.emojiIds = {};
  if (!db.settings || typeof db.settings !== 'object') db.settings = {};
  if (!db.settings.backup || typeof db.settings.backup !== 'object') {
    db.settings.backup = { enabled: false, intervalMinutes: 60, groupId: null };
  }
  if (!db.settings.forceJoin || typeof db.settings.forceJoin !== 'object') {
    db.settings.forceJoin = { enabled: false, channels: [] };
  }
  if (!Array.isArray(db.settings.forceJoin.channels)) db.settings.forceJoin.channels = [];
  if (!db.settings.channelNotif || typeof db.settings.channelNotif !== 'object') {
    db.settings.channelNotif = { enabled: false, chatRef: null, title: null, notifyPurchase: true, notifyTopup: true, notifyReferral: true, notifyMaintenance: true };
  }
  if (typeof db.settings.channelNotif.notifyPurchase !== 'boolean') db.settings.channelNotif.notifyPurchase = true;
  if (typeof db.settings.channelNotif.notifyTopup !== 'boolean') db.settings.channelNotif.notifyTopup = true;
  if (typeof db.settings.channelNotif.notifyReferral !== 'boolean') db.settings.channelNotif.notifyReferral = true;
  if (typeof db.settings.channelNotif.notifyMaintenance !== 'boolean') db.settings.channelNotif.notifyMaintenance = true;
  if (!db.settings.maintenance || typeof db.settings.maintenance !== 'object') {
    db.settings.maintenance = { enabled: false, message: null };
  }
  if (typeof db.settings.maintenance.enabled !== 'boolean') db.settings.maintenance.enabled = false;
  if (typeof db.settings.maintenance.message === 'undefined') db.settings.maintenance.message = null;
  // Migrasi: produk lama (dibuat sebelum fitur "🖼️ Set Logo Produk" ada) belum
  // punya field logoUrl sama sekali -> tambahkan default null supaya kode lain
  // yang baca product.logoUrl tidak pernah dapat `undefined` (aman dipakai
  // langsung di productLogoUrl()/if-check tanpa cek tambahan).
  if (Array.isArray(db.products)) {
    db.products.forEach(p => {
      if (typeof p.logoUrl === 'undefined') p.logoUrl = null;
    });
  }
  // Migrasi: log order fitur "🎁 Buy Gift" / "💌 Confess Gift" (lihat
  // createGiftOrder() di bawah) - db.json lama belum punya array ini.
  if (!Array.isArray(db.giftOrders)) db.giftOrders = [];
  return db;
}

// Tulis db.json secara ATOMIC: tulis dulu ke file sementara (.tmp), baru
// rename ke nama asli. rename() di level filesystem itu atomic (all-or-
// nothing) - jadi kalau proses mati/di-kill PAS lagi nulis, db.json yang
// LAMA tetap utuh (tidak pernah ke-truncate setengah jalan). Tanpa ini,
// kill proses di tengah writeFileSync bisa bikin db.json corrupt -> bot
// gagal start lagi karena JSON.parse error.
function writeDb(db) {
  const tmpPath = DB_PATH + '.tmp';
  const json = JSON.stringify(db, null, 2);
  fs.writeFileSync(tmpPath, json);
  fs.renameSync(tmpPath, DB_PATH);
  // Simpan salinan cadangan best-effort (tidak boleh sampai bikin writeDb
  // gagal kalau ini error, makanya dibungkus try/catch sendiri).
  try { fs.writeFileSync(DB_PATH + '.bak', json); } catch (_) {}
}

function getUser(chatId, username) {
  const db = readDb();
  if (!db.users[chatId]) {
    db.users[chatId] = {
      username: username || '',
      balance: 0,
      referredBy: null,      // chatId user yang mengundang (null kalau bukan hasil referral)
      referralCount: 0,      // jumlah orang yang berhasil diundang
      referralEarnings: 0,   // total saldo yang didapat dari program referral
      lang: null             // 'id' | 'en' | null (null = belum pernah pilih bahasa)
    };
    writeDb(db);
  } else if (username && db.users[chatId].username !== username) {
    db.users[chatId].username = username;
    writeDb(db);
  }
  return db.users[chatId];
}

// ===== Bahasa (i18n) per-user =====
// Default 'id' kalau user belum pernah pilih bahasa sama sekali - dipakai
// oleh lang.js supaya semua teks tetap tampil (bukan error) walau chatId
// belum sempat lewat alur pilih-bahasa (mis. user lama sebelum fitur ini ada).
function getUserLang(chatId) {
  const db = readDb();
  const user = db.users[chatId];
  return (user && user.lang) || 'id';
}

// Return true kalau user ini BELUM PERNAH pilih bahasa sama sekali (dipakai
// buat mutuskan apakah perlu munculin layar pilih-bahasa dulu pas /start).
function hasChosenLang(chatId) {
  const db = readDb();
  const user = db.users[chatId];
  return !!(user && user.lang);
}

function setUserLang(chatId, langCode) {
  const db = readDb();
  if (!db.users[chatId]) {
    db.users[chatId] = { username: '', balance: 0, referredBy: null, referralCount: 0, referralEarnings: 0, lang: null };
  }
  db.users[chatId].lang = langCode;
  writeDb(db);
  return db.users[chatId].lang;
}

// Daftarkan user baru sebagai hasil referral dari `referrerChatId`.
// ===== PATCH v7: FIX celah "referral tuyul" =====
// SEBELUMNYA: reward langsung dikreditkan ke pengundang begitu user baru
// ketik /start lewat link referral - TANPA syarat apapun lain. Ini gampang
// banget dieksploitasi: bikin akun Telegram baru sebanyak-banyaknya (nomor
// virtual/VoIP gampang & murah didapat), /start pakai link referral sendiri
// dari tiap akun baru itu -> reward masuk terus tanpa ada uang beneran yang
// masuk ke toko sama sekali ("di-tuyul").
// SEKARANG: fungsi ini CUMA mencatat relasi referral (siapa ngundang siapa)
// - TIDAK ada reward diberikan di sini. Reward baru dikreditkan lewat
// creditReferralOnFirstDeposit() di bawah, DIPICU HANYA saat user yang
// diundang itu BENERAN top-up saldo pertama kalinya lewat salah satu
// payment gateway (QRIS/USDT/TON/Binance Pay - lihat pemanggilnya di
// bot.js, di 4 titik pollXxxDeposit() setelah status jadi 'paid'). Syarat
// ini jauh lebih mahal buat dieksploitasi - pelaku curang harus BENERAN
// setor uang asli lewat gateway pembayaran asli untuk tiap akun palsu yang
// dibikin, bukan cuma modal nomor SIM murah.
// Return null kalau referral tidak valid (self-referral, referrer tidak
// ada, atau user ini bukan user baru), atau { referrerChatId } kalau
// relasinya berhasil dicatat (BUKAN berarti reward sudah diberikan).
function registerReferral(newChatId, referrerChatId) {
  if (!referrerChatId || String(referrerChatId) === String(newChatId)) return null;
  const db = readDb();
  const newUser = db.users[newChatId];
  const referrer = db.users[referrerChatId];
  if (!newUser || !referrer) return null;
  if (newUser.referredBy) return null; // sudah pernah diproses sebelumnya

  newUser.referredBy = referrerChatId;
  writeDb(db);
  return { referrerChatId };
}

// Dipanggil setiap kali ADA deposit yang statusnya baru saja jadi 'paid'
// lewat payment gateway asli (QRIS/USDT/TON/Binance - BUKAN penyesuaian
// saldo manual oleh admin, supaya admin bebas koreksi/refund saldo tanpa
// sengaja memicu reward referral berkali-kali). Kreditkan reward ke
// pengundang HANYA kalau: (1) user ini memang diundang seseorang
// (referredBy ada), dan (2) ini benar-benar deposit sukses PERTAMA user
// ini (referralRewardGiven belum pernah true) - dicek & di-set di sini
// supaya user tidak bisa top-up berkali-kali untuk trigger reward
// berkali-kali dari 1 kali diundang.
// Return null kalau tidak ada reward yang perlu diberikan, atau
// { referrerChatId, reward, newBalance } kalau berhasil dikreditkan.
function creditReferralOnFirstDeposit(newChatId, rewardAmount) {
  const db = readDb();
  const newUser = db.users[newChatId];
  if (!newUser || !newUser.referredBy || newUser.referralRewardGiven) return null;
  const referrer = db.users[newUser.referredBy];
  if (!referrer) return null;

  newUser.referralRewardGiven = true;
  referrer.referralCount = (referrer.referralCount || 0) + 1;
  referrer.referralEarnings = (referrer.referralEarnings || 0) + rewardAmount;
  referrer.balance = (referrer.balance || 0) + rewardAmount;
  writeDb(db);
  return { referrerChatId: newUser.referredBy, reward: rewardAmount, newBalance: referrer.balance };
}

function getReferralStats(chatId) {
  const db = readDb();
  const user = db.users[chatId] || {};
  return {
    referralCount: user.referralCount || 0,
    referralEarnings: user.referralEarnings || 0
  };
}

function updateBalance(chatId, delta) {
  // Guard terakhir: kalau ada pemanggil lain (sekarang atau nanti) yang lupa
  // validasi input sebelum sampai sini dan `delta` ternyata NaN, JANGAN
  // ditulis ke saldo - NaN + apapun = NaN, dan sekali saldo user jadi NaN
  // itu RUSAK PERMANEN (tidak kebaca lagi sebagai angka, tidak bisa
  // dipulihkan lewat transaksi normal apapun). Lebih aman gagal diam-diam
  // (saldo tetap seperti semula) daripada korupsi data user.
  if (typeof delta !== 'number' || isNaN(delta)) {
    console.error(`⚠️ updateBalance(${chatId}, ${delta}) ditolak - delta bukan angka valid.`);
    const db = readDb();
    return (db.users[chatId] && db.users[chatId].balance) || 0;
  }
  const db = readDb();
  if (!db.users[chatId]) db.users[chatId] = { username: '', balance: 0 };
  db.users[chatId].balance += delta;
  writeDb(db);
  return db.users[chatId].balance;
}

function findProduct(productId) {
  const db = readDb();
  return db.products.find(p => p.id === productId);
}

function findVariant(productId, variantId) {
  const product = findProduct(productId);
  if (!product) return null;
  return product.variants.find(v => v.id === variantId);
}

// Lowest tier price - used as the "starting from" price in listings
function getBasePrice(variant) {
  if (!variant.tiers || variant.tiers.length === 0) return 0;
  return variant.tiers[0].price;
}

// Highest-quantity tier price (the "500+" bulk price) - used in the
// Available Products listing per admin request
function getBulkPrice(variant) {
  if (!variant.tiers || variant.tiers.length === 0) return 0;
  return variant.tiers[variant.tiers.length - 1].price;
}

// Unit price for a given quantity, based on bulk discount tiers
function getUnitPriceForQty(variant, qty) {
  const tiers = variant.tiers || [];
  const tier = tiers.find(t => qty >= t.min && (t.max === null || qty <= t.max));
  const fallback = tiers[tiers.length - 1];
  return tier ? tier.price : (fallback ? fallback.price : 0);
}

function decrementStock(productId, variantId, qty) {
  const db = readDb();
  const product = db.products.find(p => p.id === productId);
  const variant = product && product.variants.find(v => v.id === variantId);
  if (!variant) return false;
  variant.stock = Math.max(0, (variant.stock || 0) - qty);
  writeDb(db);
  return true;
}

// ===== PATCH: pisahkan stok live Supplier/Canboso (variant.liveStock) dari
// stok manual (variant.stock, dimirror dari stockItems.length via
// addStockItems/popStockItems di bawah, atau angka manual polos untuk
// varian tanpa auto-delivery) - lihat setVariantStock() lebih bawah untuk
// kronologi bug-nya. Dua sumber ini sekarang DIJUMLAH (bukan saling timpa)
// lewat getTotalStock() supaya "Stock: N" yang ditampilkan ke buyer/admin
// selalu mencerminkan total yang benar-benar bisa dipenuhi.
function getTotalStock(variant) {
  if (!variant) return 0;
  return (variant.liveStock || 0) + (variant.stock || 0);
}

// Kebalikan dari popStockItems() - kembalikan item ke stockItems (di DEPAN
// array, supaya urutan FIFO semula tetap terjaga) kalau order lokal sudah
// terlanjur dipop tapi ternyata gagal diselesaikan (mis. panggilan Supplier/
// Canboso API buat sisa qty-nya gagal setelah stok lokal dipakai duluan -
// lihat alur partial fulfillment di bot.js handler 'confirm:'). Tanpa ini,
// item yang sudah dipop tapi order dibatalkan akan hilang percuma dari
// database walau belum pernah benar-benar terkirim ke buyer manapun.
function restoreStockItems(productId, variantId, items) {
  if (!items || !items.length) return false;
  const db = readDb();
  const product = db.products.find(p => p.id === productId);
  const variant = product && product.variants.find(v => v.id === variantId);
  if (!variant) return false;
  if (!Array.isArray(variant.stockItems)) variant.stockItems = [];
  variant.stockItems.unshift(...items);
  variant.stock = variant.stockItems.length;
  writeDb(db);
  return true;
}

// ===== Auto-delivery stock items (mis. link redeem Gemini Premium) =====
// Setiap baris teks yang admin masukkan = 1 unit stok siap kirim otomatis.
// variant.stockItems: string[] . variant.stock selalu disinkronkan ke
// stockItems.length begitu varian tersebut dipakai untuk auto-delivery.

function addStockItems(productId, variantId, items) {
  const db = readDb();
  const product = db.products.find(p => p.id === productId);
  const variant = product && product.variants.find(v => v.id === variantId);
  if (!variant) return null;
  if (!Array.isArray(variant.stockItems)) variant.stockItems = [];
  const clean = (items || []).map(s => String(s).trim()).filter(Boolean);
  variant.stockItems.push(...clean);
  variant.stock = variant.stockItems.length;
  writeDb(db);
  return { added: clean.length, total: variant.stock };
}

// Ambil & hapus `qty` item stok teratas (FIFO) untuk dikirim ke pembeli.
// Return null kalau varian ini belum pakai auto-delivery ATAU stok item kurang
// dari qty -> caller wajib fallback ke alur manual (notifikasi admin).
function popStockItems(productId, variantId, qty) {
  const db = readDb();
  const product = db.products.find(p => p.id === productId);
  const variant = product && product.variants.find(v => v.id === variantId);
  if (!variant || !Array.isArray(variant.stockItems)) return null;
  if (variant.stockItems.length < qty) return null;
  const items = variant.stockItems.splice(0, qty);
  variant.stock = variant.stockItems.length;
  writeDb(db);
  return items;
}

function getStockItemCount(productId, variantId) {
  const variant = findVariant(productId, variantId);
  return variant && Array.isArray(variant.stockItems) ? variant.stockItems.length : 0;
}

// ===== Wallet deposits (topup otomatis via QRIS / USDT BEP20) =====

function createDeposit(fields) {
  const db = readDb();
  const id = 'dep_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const record = { id, status: 'pending', createdAt: new Date().toISOString(), ...fields };
  db.deposits.push(record);
  writeDb(db);
  return record;
}

function getDeposit(id) {
  const db = readDb();
  return db.deposits.find(d => d.id === id);
}

function updateDeposit(id, patch) {
  const db = readDb();
  const d = db.deposits.find(x => x.id === id);
  if (!d) return null;
  Object.assign(d, patch);
  writeDb(db);
  return d;
}

function getPendingDeposits(method) {
  const db = readDb();
  return db.deposits.filter(d => d.status === 'pending' && (!method || d.method === method));
}

// Nominal USDT yang lagi dipakai deposit pending lain - dipakai untuk
// menghindari 2 deposit pending punya nominal unik yang sama persis.
function getUsedUsdtAmounts() {
  const db = readDb();
  return new Set(
    db.deposits
      .filter(d => d.method === 'usdt_bep20' && d.status === 'pending')
      .map(d => d.usdtAmount)
  );
}

// Sama seperti getUsedUsdtAmounts() di atas, tapi untuk deposit TON.
function getUsedTonAmounts() {
  const db = readDb();
  return new Set(
    db.deposits
      .filter(d => d.method === 'ton' && d.status === 'pending')
      .map(d => d.tonAmount)
  );
}

// Sama seperti getUsedUsdtAmounts()/getUsedTonAmounts() di atas, tapi untuk
// deposit Binance Pay.
function getUsedBinanceAmounts() {
  const db = readDb();
  return new Set(
    db.deposits
      .filter(d => d.method === 'binance' && d.status === 'pending')
      .map(d => d.binanceAmount)
  );
}

// ⚠️ PENTING - proteksi anti replay/double-credit:
// fetchIncomingUsdtTransfers()/fetchIncomingTonTransfers() nge-scan histori
// on-chain sampai ~2,5 jam ke belakang (jauh lebih lama dari masa berlaku
// 1 deposit yang cuma 30 menit). getUsedUsdtAmounts()/getUsedTonAmounts()
// di atas cuma ngecek nominal dari deposit yang MASIH 'pending' - deposit
// yang sudah 'paid' tidak dihitung lagi. Jadi kalau toko lagi ramai, 2 user
// beda bisa saja kebagian nominal unik yang SAMA PERSIS dalam rentang 2,5
// jam itu (cuma ada ~999 variasi 4 desimal). Begitu itu terjadi, polling
// berikutnya bakal cocokkan transaksi LAMA yang sudah pernah dipakai buat
// bayar deposit user pertama ke deposit user kedua -> user kedua ke-credit
// saldo TANPA benar-benar transfer apapun (double-credit/replay exploit).
// Makanya SETIAP match transfer WAJIB dicek dulu txHash-nya belum pernah
// dipakai buat deposit lain sebelum saldo dikreditkan - lihat isTxHashUsed().
function isTxHashUsed(hash) {
  if (!hash) return false;
  const db = readDb();
  return db.deposits.some(d => d.txHash === hash);
}

// `supplierMeta` opsional: { supplierServiceId, supplierOrderId } - diisi
// kalau order ini dipenuhi lewat Supplier API (AIVerse Hub) alih-alih stok
// lokal, supaya admin bisa lacak balik order mana yang butuh dicek di sisi
// API kalau ada komplain buyer (lihat supplier.js / admin:supplier di bot.js).
function createOrder(chatId, productId, variantId, qty, unitPrice, total, deliveredItems, username, supplierMeta) {
  const db = readDb();
  // PENTING: pakai Date.now() + random suffix, BUKAN Date.now() saja - sama
  // seperti pola id deposit/channel di atas. Date.now() cuma presisi
  // milidetik, jadi 2 order dari 2 buyer berbeda yang diproses SANGAT dekat
  // (mis. dalam milidetik yang sama saat toko ramai) bisa dapat id KEMBAR.
  // getOrderById() pakai .find() (ambil match PERTAMA) - kalau id kembar
  // terjadi, fitur "🔍 Cek Order ID", log pengiriman, dan tombol
  // "🔄 Refresh Kode 2FA"/"🏅 Recover Product" bisa salah ambil/nampilin
  // detail akun order LAIN yang bukan miliknya - jadi wajib unik.
  const id = 'ord_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const delivered = Array.isArray(deliveredItems) && deliveredItems.length > 0;
  db.orders.push({
    id, chatId, username: username || '', productId, variantId, qty, unitPrice, total,
    createdAt: new Date().toISOString(), status: 'paid',
    delivered,
    deliveredItems: delivered ? deliveredItems : [],
    ...(supplierMeta ? {
      supplierServiceId: supplierMeta.supplierServiceId,
      supplierOrderId: supplierMeta.supplierOrderId,
      // Opsional: potongan raw response API luar, cuma diisi kalau
      // ekstraksi item gagal (lihat bot.js) - dipakai admin/developer buat
      // lacak balik field mapping yang meleset, tanpa perlu andalkan
      // notifikasi Telegram yang bisa terlewat.
      ...(supplierMeta.rawDebug ? { rawDebug: supplierMeta.rawDebug } : {})
    } : {})
  });
  writeDb(db);
  return id;
}

function getOrdersByUser(chatId) {
  const db = readDb();
  return db.orders.filter(o => o.chatId === chatId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ===== Audit log pengiriman otomatis =====
function getOrderById(orderId) {
  const db = readDb();
  return db.orders.find(o => o.id === orderId) || null;
}

function getDeliveryLogs(limit) {
  const db = readDb();
  return db.orders
    .filter(o => o.delivered)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit || 10);
}

function setPendingAction(chatId, action) {
  const db = readDb();
  db.pendingAction[chatId] = action;
  writeDb(db);
}

function getPendingAction(chatId) {
  const db = readDb();
  return db.pendingAction[chatId];
}

function clearPendingAction(chatId) {
  const db = readDb();
  delete db.pendingAction[chatId];
  writeDb(db);
}

// ===== Auto Backup settings =====
function getBackupSettings() {
  const db = readDb();
  return db.settings.backup;
}

// partial: subset dari { enabled, intervalMinutes, groupId } yang mau diubah.
// Return object settings terbaru (full, sudah di-merge).
function setBackupSettings(partial) {
  const db = readDb();
  db.settings.backup = { ...db.settings.backup, ...partial };
  writeDb(db);
  return db.settings.backup;
}

// ===== Harga Gift (markup% & kurs Stars->USD, override GIFT_MARKUP_PCT /
// STARS_TO_USD_RATE dari .env - lihat giftPriceUsd() di bot.js) =====
// null = belum di-override, pakai default dari .env (config.js). Disimpan
// terpisah dari giftPriceUsd() sendiri supaya admin bisa ubah live dari
// chat Telegram TANPA perlu restart server (beda dari env var yang harus
// restart proses buat kebaca ulang).
function getGiftPricingSettings() {
  const db = readDb();
  if (!db.settings.giftPricing) db.settings.giftPricing = { markupPct: null, starsToUsdRate: null };
  return db.settings.giftPricing;
}

// partial: subset dari { markupPct, starsToUsdRate } yang mau diubah.
function setGiftPricingSettings(partial) {
  const db = readDb();
  db.settings.giftPricing = { ...(db.settings.giftPricing || { markupPct: null, starsToUsdRate: null }), ...partial };
  writeDb(db);
  return db.settings.giftPricing;
}

// ===== Wajib Join Channel =====
function getForceJoinSettings() {
  return readDb().settings.forceJoin;
}

function setForceJoinEnabled(enabled) {
  const db = readDb();
  db.settings.forceJoin.enabled = !!enabled;
  writeDb(db);
  return db.settings.forceJoin;
}

function addForceJoinChannel({ title, link, chatRef }) {
  const db = readDb();
  const id = 'ch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const channel = { id, title: title || chatRef, link, chatRef };
  db.settings.forceJoin.channels.push(channel);
  writeDb(db);
  return channel;
}

function removeForceJoinChannel(id) {
  const db = readDb();
  const before = db.settings.forceJoin.channels.length;
  db.settings.forceJoin.channels = db.settings.forceJoin.channels.filter(c => c.id !== id);
  writeDb(db);
  return db.settings.forceJoin.channels.length < before;
}

function getForceJoinChannels() {
  return readDb().settings.forceJoin.channels;
}

// ===== Notifikasi Channel Otomatis (New Purchase / New Wallet Top-Up) =====
function getChannelNotifSettings() {
  return readDb().settings.channelNotif;
}

// partial: subset dari { enabled, chatRef, title, notifyPurchase, notifyTopup }
// yang mau diubah. Return object settings terbaru (full, sudah di-merge).
function setChannelNotifSettings(partial) {
  const db = readDb();
  db.settings.channelNotif = { ...db.settings.channelNotif, ...partial };
  writeDb(db);
  return db.settings.channelNotif;
}

// ===== Mode Maintenance Bot =====
function getMaintenanceSettings() {
  return readDb().settings.maintenance;
}

// partial: subset dari { enabled, message } yang mau diubah. `message: null`
// artinya balik pakai teks default (lihat buildMaintenanceText() di bot.js).
// Return object settings terbaru (full, sudah di-merge).
function setMaintenanceSettings(partial) {
  const db = readDb();
  db.settings.maintenance = { ...db.settings.maintenance, ...partial };
  writeDb(db);
  return db.settings.maintenance;
}

// ===== List User (admin "📋 List User") =====
// Return SEMUA user terdaftar sebagai array (chatId ikut disisipkan di tiap
// object-nya, karena di db.json chatId cuma jadi KEY object `users`, bukan
// field di dalam value-nya). orderCount dihitung on-the-fly dari db.orders -
// tidak disimpan sebagai field terpisah di user, supaya selalu akurat walau
// ada order yang dihapus/diubah manual. Urutan hasil array SAMA PERSIS
// dengan urutan Object.keys(db.users) - untuk key numerik (chatId Telegram
// selalu numerik), JavaScript otomatis mengurutkannya ASCENDING secara
// otomatis (bukan urutan pendaftaran), jadi user dengan chatId lebih kecil
// akan selalu tampil lebih dulu.
function getUsersList() {
  const db = readDb();
  const orders = Array.isArray(db.orders) ? db.orders : [];
  return Object.keys(db.users).map(chatId => {
    const u = db.users[chatId] || {};
    const orderCount = orders.filter(o => String(o.chatId) === String(chatId)).length;
    return {
      chatId,
      username: u.username || '',
      balance: u.balance || 0,
      referralCount: u.referralCount || 0,
      orderCount
    };
  });
}

function addProduct(id, name, emoji) {
  const db = readDb();
  if (db.products.find(p => p.id === id)) return false;
  db.products.push({ id, name, emoji: emoji || '📦', emojiId: null, logoUrl: null, variants: [] });
  writeDb(db);
  return true;
}

// Set/ganti URL logo resmi 1 produk (mis. logo Netflix/Spotify/Gemini) -
// dipakai di notifikasi channel supaya tiap produk tampil dengan logo
// aplikasinya sendiri, bukan cuma emoji. url null/'' -> hapus logo (balik
// pakai emoji seperti biasa, tidak error). Return false kalau produk tidak
// ditemukan.
function setProductLogo(productId, url) {
  const db = readDb();
  const product = db.products.find(p => p.id === productId);
  if (!product) return false;
  product.logoUrl = url || null;
  writeDb(db);
  return true;
}

// Set/ganti custom emoji premium 1 produk (dipakai di productEmojiHtml() -
// bot.js). "emoji" = karakter unicode fallback (buat client lama/emoji
// biasa), "emojiId" = custom_emoji_id ASLI hasil forward pesan owner sendiri
// dari panel Telegram Premium-nya (lihat handler 'setemoji_capture' di
// bot.js) - null kalau owner cuma mau pakai unicode biasa tanpa premium.
// Return false kalau produk tidak ditemukan.
function setProductEmoji(productId, emoji, emojiId) {
  const db = readDb();
  const product = db.products.find(p => p.id === productId);
  if (!product) return false;
  product.emoji = emoji || '📦';
  product.emojiId = emojiId || null;
  writeDb(db);
  return true;
}

// Alur utama "➕ Tambah Produk": nama + harga + deskripsi saja.
// Otomatis bikin 1 produk dengan 1 varian default (id: `${id}-default`),
// stok mulai dari 0 - stok diisi belakangan lewat "📥 Tambah Stock".
// emoji: karakter unicode fallback (dipakai di tombol/teks Markdown yang tidak
// bisa render custom emoji). emojiId: custom_emoji_id ASLI kalau owner pilih
// emoji itu langsung dari panel Telegram Premium-nya saat ngetik nama produk
// (lihat handler 'addproduct_name' di TEXT MESSAGES) - kalau kosong/null berarti
// owner cuma ngetik emoji unicode biasa (atau tidak pakai emoji sama sekali),
// otomatis fallback ke `emoji` polos / 📦, tidak ada error.
function addSimpleProduct(id, name, price, description, emoji, emojiId) {
  const db = readDb();
  if (db.products.find(p => p.id === id)) return null;
  const variantId = id + '-default';
  db.products.push({
    id,
    name,
    emoji: emoji || '📦',
    emojiId: emojiId || null,
    logoUrl: null,
    variants: [{
      id: variantId,
      label: name,
      stock: 0,
      tiers: [{ min: 1, max: null, price }],
      description: description || '',
      howToUse: ''
    }]
  });
  writeDb(db);
  return { productId: id, variantId };
}

function addVariant(productId, variantId, label, price, stock, description) {
  const db = readDb();
  const product = db.products.find(p => p.id === productId);
  if (!product) return false;
  // Cegah 2 varian di produk yang sama punya id KEMBAR (mis. admin ketik
  // label yang sama/mirip dua kali, sehingga slug id-nya sama persis).
  // Tanpa cek ini, findVariant() (pakai .find(), ambil match PERTAMA) akan
  // selalu ambil varian LAMA - varian baru jadi "ghost" yang kelihatan di
  // daftar tapi kalau diklik/diedit (stok, harga, dll) yang berubah malah
  // punya varian lama, bikin admin bingung kenapa perubahannya "tidak masuk".
  if (product.variants.some(v => v.id === variantId)) return false;
  product.variants.push({
    id: variantId,
    label,
    stock: stock || 0,
    tiers: [{ min: 1, max: null, price }],
    // BUG FIX: dulu field ini tidak pernah di-set sama sekali di sini, jadi
    // varian baru selalu tampil tanpa deskripsi. Sekarang ikut disimpan
    // (default string kosong kalau admin tidak mengisi apa-apa), sama
    // seperti addSimpleProduct() di atas.
    description: description || '',
    howToUse: ''
  });
  writeDb(db);
  return true;
}

// Ubah harga dasar (tier pertama) sebuah varian. Kalau varian punya diskon
// grosir bertingkat (tiers > 1), tier-tier lain TIDAK ikut berubah otomatis -
// itu tetap harus diedit manual di data/db.json biar aman, ini cuma ubah
// harga dasarnya saja (tier 1: min 1).
function setVariantPrice(productId, variantId, price) {
  const db = readDb();
  const product = db.products.find(p => p.id === productId);
  const variant = product && product.variants.find(v => v.id === variantId);
  if (!variant) return false;
  if (!Array.isArray(variant.tiers) || variant.tiers.length === 0) {
    variant.tiers = [{ min: 1, max: null, price }];
  } else {
    variant.tiers[0].price = price;
  }
  writeDb(db);
  return true;
}

// ===== Supplier API (AIVerse Hub) - link 1 varian ke 1 service_id remote =====
// Kalau variant.supplierServiceId terisi, alur beli (lihat bot.js) akan
// pesan produknya OTOMATIS lewat API supplier (bukan dari stockItems lokal)
// begitu ada buyer beli varian ini. Lihat supplier.js untuk integrasi API-nya.
function setVariantSupplier(productId, variantId, serviceId, costPrice) {
  const db = readDb();
  const product = db.products.find(p => p.id === productId);
  const variant = product && product.variants.find(v => v.id === variantId);
  if (!variant) return false;
  variant.supplierServiceId = serviceId;
  // Harga modal (cost) dari AIVerse Hub PADA SAAT dihubungkan - disimpan
  // biar bisa hitung margin (modal vs harga jual lokal) tanpa perlu panggil
  // API lagi tiap kali tampilkan menu Supplier API. Modal AIVerse Hub bisa
  // berubah sewaktu-waktu di sisi mereka - nilai ini snapshot, bukan live.
  if (typeof costPrice === 'number' && !isNaN(costPrice)) {
    variant.supplierCost = costPrice;
  }
  writeDb(db);
  return true;
}

function clearVariantSupplier(productId, variantId) {
  const db = readDb();
  const product = db.products.find(p => p.id === productId);
  const variant = product && product.variants.find(v => v.id === variantId);
  if (!variant) return false;
  delete variant.supplierServiceId;
  delete variant.supplierCost;
  writeDb(db);
  return true;
}

// Sinkron stok LIVE dari Supplier/Canboso API ke variant.liveStock - dipakai
// oleh 'admin:supplierrefresh', refreshSupplierData(), dan live-check
// Canboso di handler 'variant:'/'confirm:' bot.js.
// ===== BUG FIX: dulu fungsi ini menimpa variant.stock langsung - field yang
// SAMA dipakai juga oleh stok manual (stockItems.length, lihat addStockItems/
// popStockItems di atas). Karena keduanya sumber terpisah yang berebut 1
// field, sync live berikutnya bisa menimpa stok manual admin jadi 0/basi
// (kalau saldo/stok di sisi API luar kebetulan habis), padahal stok manual
// lokal masih ada dan siap kirim. Sekarang ditulis ke field liveStock yang
// terpisah - variant.stock (mirror stok manual) tidak pernah disentuh di
// sini lagi. Pakai getTotalStock(variant) untuk dapat angka gabungan
// (live + manual) buat ditampilkan ke buyer/admin.
function setVariantStock(productId, variantId, stock) {
  const db = readDb();
  const product = db.products.find(p => p.id === productId);
  const variant = product && product.variants.find(v => v.id === variantId);
  if (!variant) return false;
  if (typeof stock !== 'number' || isNaN(stock)) return false;
  variant.liveStock = Math.max(0, Math.round(stock));
  writeDb(db);
  return true;
}

// ===== FITUR BARU: 🔢 Tambah Stock Manual (Angka) =====
// Beda dari addStockItems() di atas (yang nerima link/kode REAL per baris
// untuk auto-delivery), fungsi ini cuma NAMBAH ANGKA polos ke variant.stock
// - dipakai admin lewat /admin -> 📥 Tambah Stock -> "🔢 Tambah Angka Saja
// (Manual)" untuk produk yang TIDAK auto-kirim (mis. akun yang dikirim
// manual sendiri oleh admin ke buyer setelah order masuk). Tetap pakai
// field variant.stock yang SAMA dengan mirror stockItems.length (lihat
// komentar di setVariantStock di atas) - jadi kalau varian ini nanti JUGA
// dipakai lewat addStockItems (paste link), stock akan ketimpa jadi
// stockItems.length lagi (bukan lagi angka manual ini) - ini SENGAJA
// konsisten dengan cara variant.stock sudah dipakai selama ini, cukup
// jangan campur 2 cara itu di 1 varian yang sama kalau tidak mau angkanya
// ketimpa.
function addManualStock(productId, variantId, qty) {
  const db = readDb();
  const product = db.products.find(p => p.id === productId);
  const variant = product && product.variants.find(v => v.id === variantId);
  if (!variant) return null;
  const addQty = Math.round(Number(qty));
  if (!addQty || isNaN(addQty) || addQty <= 0) return null;
  variant.stock = (variant.stock || 0) + addQty;
  writeDb(db);
  return { added: addQty, total: variant.stock };
}

// Timpa langsung array tiers (harga jual per rentang qty) 1 varian - dipakai
// oleh refreshSupplierData() di bot.js untuk menghitung ULANG harga jual
// varian Supplier API dari modal live + persentase markup (lihat
// DEFAULT_SUPPLIER_TIER_MARKUP / getVariantTierMarkup), supaya harga yang
// dilihat buyer selalu ikut harga terbaru Supplier, bukan angka basi.
function setVariantTiers(productId, variantId, tiers) {
  const db = readDb();
  const product = db.products.find(p => p.id === productId);
  const variant = product && product.variants.find(v => v.id === variantId);
  if (!variant || !Array.isArray(tiers) || !tiers.length) return false;
  variant.tiers = tiers;
  writeDb(db);
  return true;
}

// Override markup per-varian (opsional) - kalau tidak diset, refreshSupplierData()
// pakai DEFAULT_SUPPLIER_TIER_MARKUP dari config.js untuk SEMUA varian
// Supplier API. Dipakai kalau 1 produk tertentu butuh markup beda sendiri
// (mis. produk yang lebih kompetitif butuh margin lebih tipis).
function setVariantTierMarkup(productId, variantId, tierMarkup) {
  const db = readDb();
  const product = db.products.find(p => p.id === productId);
  const variant = product && product.variants.find(v => v.id === variantId);
  if (!variant || !Array.isArray(tierMarkup) || !tierMarkup.length) return false;
  variant.tierMarkup = tierMarkup;
  writeDb(db);
  return true;
}

function getVariantTierMarkup(variant, defaultMarkup) {
  return (variant && Array.isArray(variant.tierMarkup) && variant.tierMarkup.length)
    ? variant.tierMarkup
    : defaultMarkup;
}

// Toggle "kunci harga manual" per varian - kalau true, refreshSupplierData()
// di bot.js akan skip perhitungan ULANG tier (computeTiersFromCost) buat
// varian ini walau tetap sinkron modal (supplierCost) & stok seperti biasa.
// Dipakai buat varian Supplier API yang admin sudah set harga manual lewat
// "🎁 Set Tier Diskon Grosir" dan tidak mau harganya ketimpa auto-sync lagi.
function setVariantPriceLock(productId, variantId, locked) {
  const db = readDb();
  const product = db.products.find(p => p.id === productId);
  const variant = product && product.variants.find(v => v.id === variantId);
  if (!variant) return false;
  variant.priceLocked = !!locked;
  writeDb(db);
  return true;
}

// Daftar semua varian yang lagi terhubung ke supplier API - dipakai untuk
// tampilan "Supplier API" di /admin (lihat variant mana saja yang aktif
// auto-order via AIVerse Hub, plus tombol putus link per varian).
function getSupplierLinkedVariants() {
  const db = readDb();
  const result = [];
  db.products.forEach(p => {
    p.variants.forEach(v => {
      if (v.supplierServiceId) result.push({ productId: p.id, productName: p.name, variant: v });
    });
  });
  return result;
}

// ===== Supplier API (Canboso) - link 1 varian ke 1 product_id remote =====
// Pola PERSIS sama dengan setVariantSupplier/clearVariantSupplier/
// getSupplierLinkedVariants di atas (AIVerse Hub), tapi field terpisah
// (canbosoProductId/canbosoCost) supaya 1 varian bisa saja punya salah
// SATU dari dua supplier ini (tidak keduanya sekaligus - alur beli di
// bot.js akan prioritaskan AIVerse Hub kalau ternyata ada 2-2nya terisi,
// jadi UI link/unlink di admin sudah didesain saling eksklusif per varian).
function setVariantCanboso(productId, variantId, canbosoProductId, costPrice) {
  const db = readDb();
  const product = db.products.find(p => p.id === productId);
  const variant = product && product.variants.find(v => v.id === variantId);
  if (!variant) return false;
  variant.canbosoProductId = canbosoProductId;
  if (typeof costPrice === 'number' && !isNaN(costPrice)) {
    variant.canbosoCost = costPrice;
  }
  writeDb(db);
  return true;
}

function clearVariantCanboso(productId, variantId) {
  const db = readDb();
  const product = db.products.find(p => p.id === productId);
  const variant = product && product.variants.find(v => v.id === variantId);
  if (!variant) return false;
  delete variant.canbosoProductId;
  delete variant.canbosoCost;
  writeDb(db);
  return true;
}

function getCanbosoLinkedVariants() {
  const db = readDb();
  const result = [];
  db.products.forEach(p => {
    p.variants.forEach(v => {
      if (v.canbosoProductId) result.push({ productId: p.id, productName: p.name, variant: v });
    });
  });
  return result;
}

function setHowToUse(productId, variantId, text) {
  const db = readDb();
  const product = db.products.find(p => p.id === productId);
  const variant = product && product.variants.find(v => v.id === variantId);
  if (!variant) return false;
  variant.howToUse = text;
  writeDb(db);
  return true;
}

// Sama seperti setHowToUse() di atas, tapi untuk field "description" -
// dipakai admin action "Set Deskripsi" (mirror dari "Set How to Use") supaya
// deskripsi varian yang dibuat lewat "Tambah Varian" (yang dulu tidak pernah
// nanya deskripsi sama sekali) bisa diisi belakangan tanpa harus edit
// data/db.json manual.
// `sourceLang` ('id'|'en'): bahasa yang dipakai ADMIN saat mengetik teks ini.
// Dipakai bot.js buat mutuskan apakah deskripsi perlu di-auto-translate saat
// buyer yang /setlanguage-nya BEDA dari sourceLang ini membuka halaman
// deskripsi (lihat getLocalizedDescription() di bot.js). descriptionTranslated
// di-reset kosong tiap kali admin ganti teksnya, supaya translate cache lama
// tidak "nyangkut" dan ketampil basi kalau teks aslinya sudah diedit.
function setDescription(productId, variantId, text, sourceLang) {
  const db = readDb();
  const product = db.products.find(p => p.id === productId);
  const variant = product && product.variants.find(v => v.id === variantId);
  if (!variant) return false;
  variant.description = text;
  variant.descriptionLang = sourceLang === 'en' ? 'en' : 'id';
  variant.descriptionTranslated = {};
  writeDb(db);
  return true;
}

// Simpan hasil auto-translate deskripsi ke cache (supaya panggilan
// translate berikutnya ke bahasa yang sama tidak perlu hit API lagi).
// Aman diabaikan (return false) kalau produk/variant-nya sudah dihapus di
// antara waktu translate dimulai & selesai (async, bisa telat).
function cacheDescriptionTranslation(productId, variantId, langCode, translatedText) {
  const db = readDb();
  const product = db.products.find(p => p.id === productId);
  const variant = product && product.variants.find(v => v.id === variantId);
  if (!variant) return false;
  if (!variant.descriptionTranslated) variant.descriptionTranslated = {};
  variant.descriptionTranslated[langCode] = translatedText;
  writeDb(db);
  return true;
}

function removeProduct(productId) {
  const db = readDb();
  const before = db.products.length;
  db.products = db.products.filter(p => p.id !== productId);
  writeDb(db);
  return db.products.length < before;
}

function getAllProducts() {
  return readDb().products;
}

// ===================== Custom Emoji ID (hasil "tangkap otomatis") =====================
// key contoh: "menu:buy_produk" (ikon tombol) atau "teks:product_desc" /
// "teks:menu_notif" (emoji di dalam teks). Disimpan di db.json supaya
// PERSISTEN antar restart bot TANPA perlu admin edit file .js manual -
// diisi otomatis lewat fitur "🎨 Kelola Emoji ID" di /admin (forward emoji).
function setEmojiId(key, customEmojiId) {
  const db = readDb();
  db.emojiIds[key] = customEmojiId;
  writeDb(db);
}

function getEmojiId(key) {
  return readDb().emojiIds[key] || null;
}

function getAllEmojiIds() {
  return readDb().emojiIds;
}

function clearEmojiId(key) {
  const db = readDb();
  delete db.emojiIds[key];
  writeDb(db);
}

// ===== Gift orders (fitur "🎁 Buy Gift" / "💌 Confess Gift" - lihat userbot.js) =====
// Terpisah dari createOrder() (order produk katalog biasa) karena gift TIDAK
// punya productId/variantId/stok lokal - sumbernya katalog live dari
// Telegram (userbot.getGiftCatalog()), bukan data/db.json.
function createGiftOrder(fields) {
  const db = readDb();
  const order = {
    id: 'GFT' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(),
    chatId: fields.chatId,
    username: fields.username || '',
    mode: fields.mode,                 // 'buy' | 'confess' | 'saved'
    giftId: fields.giftId,             // id katalog (mode buy/confess) ATAU msgId saved gift (mode 'saved')
    stars: fields.stars,
    priceUsd: fields.priceUsd,
    target: fields.target,             // username/id tujuan, apa adanya
    message: fields.message || null,   // pesan anonim (mode 'confess')
    status: 'pending',                 // 'pending' | 'sent' | 'failed_refunded'
    error: null,
    createdAt: Date.now()
  };
  db.giftOrders.push(order);
  writeDb(db);
  return order;
}

function updateGiftOrder(orderId, patch) {
  const db = readDb();
  const order = db.giftOrders.find(o => o.id === orderId);
  if (!order) return null;
  Object.assign(order, patch);
  writeDb(db);
  return order;
}

function getGiftOrdersByUser(chatId) {
  const db = readDb();
  return db.giftOrders.filter(o => String(o.chatId) === String(chatId)).sort((a, b) => b.createdAt - a.createdAt);
}

module.exports = {
  readDb, writeDb, getUser, updateBalance,
  getUserLang, setUserLang, hasChosenLang,
  registerReferral, creditReferralOnFirstDeposit, getReferralStats,
  findProduct, findVariant, getBasePrice, getBulkPrice, getUnitPriceForQty, decrementStock,
  getTotalStock, restoreStockItems,
  addStockItems, popStockItems, getStockItemCount, addManualStock,
  createDeposit, getDeposit, updateDeposit, getPendingDeposits, getUsedUsdtAmounts, getUsedTonAmounts, getUsedBinanceAmounts, isTxHashUsed,
  createOrder, getOrdersByUser, getOrderById, getDeliveryLogs,
  setPendingAction, getPendingAction, clearPendingAction,
  addProduct, addSimpleProduct, addVariant, setVariantPrice, setHowToUse, setDescription, cacheDescriptionTranslation, setProductLogo, setProductEmoji, removeProduct, getAllProducts,
  setVariantSupplier, clearVariantSupplier, setVariantStock, getSupplierLinkedVariants,
  setVariantCanboso, clearVariantCanboso, getCanbosoLinkedVariants,
  setVariantTiers, setVariantTierMarkup, getVariantTierMarkup, setVariantPriceLock,
  setEmojiId, getEmojiId, getAllEmojiIds, clearEmojiId,
  getBackupSettings, setBackupSettings,
  getGiftPricingSettings, setGiftPricingSettings,
  getForceJoinSettings, setForceJoinEnabled, addForceJoinChannel, removeForceJoinChannel, getForceJoinChannels,
  getChannelNotifSettings, setChannelNotifSettings,
  getMaintenanceSettings, setMaintenanceSettings, getUsersList,
  createGiftOrder, updateGiftOrder, getGiftOrdersByUser
};
