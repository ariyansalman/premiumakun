// ============================================================
// CUSTOM EMOJI ID — IKON TOMBOL MENU INLINE (per tombol/halaman)
// ============================================================
// Dipakai untuk custom emoji yang muncul sebagai IKON di LABEL TOMBOL
// inline keyboard lewat field "icon_custom_emoji_id" pada
// InlineKeyboardButton — fitur Bot API 9.4 (rilis 9 Feb 2026). Beda
// mekanisme dari emoji di TEKS pesan (lihat emoji-id-teks.js): ini
// bukan tag HTML di dalam teks, tapi field terpisah di object tombolnya.
// Sebelum Bot API 9.4, custom emoji di tombol memang tidak didukung
// sama sekali oleh Telegram — sekarang sudah bisa.
//
// Setiap key di bawah = 1 tombol/halaman tertentu, jadi kamu bisa pasang
// ikon custom emoji yang BEDA-BEDA untuk tiap tombol (bukan cuma 1 ID
// yang sama dipakai di semua tombol).
//
// CARA ISI: tinggal ganti nilai string di bawah ini (di antara "").
// KOSONGKAN ("") kalau belum ada ID-nya — tombol tetap tampil normal
// (fallback ke teks biasa) tanpa bikin bot error, lihat iconFor() di bawah.
//
// ⚠️ SYARAT WAJIB: akun PEMILIK BOT (bukan bot-nya) wajib punya
// langganan Telegram Premium aktif. Kalau owner belum Premium / ID
// dikosongkan, tombol otomatis tampil normal TANPA ikon - bot tetap
// jalan normal, TIDAK ERROR.
//
// Cara dapat custom_emoji_id:
// 1. Kirim custom emoji yang mau dipakai ke @userinfobot atau
//    @RawDataBot (kirim dari akun Premium supaya custom emoji-nya
//    beneran ke-attach sebagai entity, bukan cuma tampil sebagai
//    teks biasa).
// 2. Lihat field "custom_emoji_id" di entities pesan tsb.
// 3. Tempel ID-nya (angka panjang, contoh: "5373141891321699086")
//    ke key yang sesuai di object EMOJI_IDS di bawah.
// ============================================================

const EMOJI_IDS = {
  // --- Menu utama /start ---
  buy_produk: "5472401690793614752",
  profile: "5249053508681883137",
  saldo_saya: "5278467510604160626",
  topup: "5267300544094948794",
  riwayat_pembelian: "5444856076954520455",
  referral: "5449800250032143374",
  support: "5201990176175299013",

  // --- Halaman Refer & Earn (tombol di dalam halamannya) ---
  share_referral: "5258043150110301407",
  copy_referral: "5987635334945444280",

  // --- Tombol halaman lainnya ---
  contact_support: "5172893417717367746",
  close_menu: "5368352122318383442",
  recover: "5377584064326804458",
  cancel_recover: "5368352122318383442",
  refresh_2fa: "5433878454078556670",

  // --- Tombol Pilihan Gift (Buy Gift/Confess Gift) ---
  // Fallback SAJA - kalau 1 gift dari katalog Telegram punya sticker
  // custom_emoji_id sendiri (lihat userbot.js getGiftCatalog()), itu yang
  // dipakai duluan buat ikon tombolnya, BUKAN ID di sini. ID ini cuma
  // dipakai kalau gift itu tidak punya sticker custom (fallback ke 🎁 polos).
  gift: "",

  // --- Menu Wallet / Topup ---
  topup_qris: "6084682277072144595",
  topup_usdt: "5292125588209804353",
  topup_ton: "5834757434333208303",
  // Baru: tombol topup Binance Pay - sengaja dikosongkan (belum pernah
  // ditangkap lewat "🎨 Kelola Emoji ID"), isi lewat admin panel atau tempel
  // manual ID-nya di sini kalau sudah punya.
  topup_binance: "",
  batal: "5969916760898408074",
  nominal_cepat: "5188605164000395914",
  nominal_custom: "5395444784611480792",
  batalkan_qris: "5974083768233760323",
  copy_address_usdt: "5292125588209804353",
  batalkan_usdt: "5974083768233760323",
  copy_address_ton: "5834757434333208303",
  batalkan_ton: "5974083768233760323",
  copy_id_binance: "",
  batalkan_binance: "",

  // --- Navigasi umum (dipakai di banyak halaman) ---
  back: "5255703720078879038",
  go_back: "5346320297299560938",

  // --- Halaman deskripsi produk ---
  how_to_use: "5420323339723881652",
  buy_now: "5440841102871517055",

  // --- Halaman jumlah & konfirmasi order ---
  jumlah_custom: "6215281817247812147",
  place_order: "5193065010795911968",
  cancel_order: "5974083768233760323",

  // --- Tombol Wajib Join Channel ---
  // Sengaja diisi ID yang SUDAH ADA & sudah kepakai di tombol lain (bukan
  // ID baru), disamakan berdasarkan MEKANISME tombolnya - supaya begitu
  // owner update kode ini, langsung tampil pakai emoji Premium yang sama
  // TANPA admin perlu forward ulang emoji manapun.
  join_channel: "5172893417717367746",  // sama dengan tombol "Contact Support" (sama-sama tombol url keluar dari bot)
  checkjoin: "5193065010795911968",     // sama dengan tombol "Place Order" (sama-sama tombol konfirmasi ✅)

  // --- Admin panel: /admin ---
  // Belum ada di data/db.json (belum pernah ditangkap lewat "🎨 Kelola
  // Emoji ID"), jadi sengaja dibiarkan kosong - isi lewat admin panel
  // atau tempel manual di sini kalau sudah punya ID-nya.
  // 4 tombol kategori di menu utama /admin (lihat adminMainKeyboard() di bot.js)
  admin_cat_products: "",
  admin_cat_users: "",
  admin_cat_reports: "",
  admin_cat_settings: "",
  // Tombol "🏠 Menu Utama" (shortcut lompat langsung ke menu utama /admin
  // dari halaman submenu manapun) - lihat adminBackKeyboard() dkk di bot.js
  admin_menu_utama: "",
  admin_daftar_produk: "",
  admin_tambah_produk: "",
  admin_hapus_produk: "",
  admin_tambah_stock: "",
  admin_tambah_varian: "",
  admin_set_harga: "",
  admin_set_howto: "",
  admin_set_logo: "",
  admin_atur_saldo: "",
  admin_topup_pending: "",
  admin_log_pengiriman: "",
  admin_cek_order: "",
  admin_statistik: "",
  admin_kelola_emoji: "",
  admin_auto_backup: "",
  admin_broadcast: "",
  admin_channel_notif: "",
  // Tombol "🎁 Kelola Emoji Gift" di kategori Gift (Userbot) - BEDA dari key
  // "gift" di atas (yang itu ikon fallback tombol PILIHAN gift-nya sendiri,
  // ini cuma ikon tombol menu admin buat masuk ke fitur "Kelola Emoji Gift").
  admin_gift_emoji: "",
};

// Ambil ID untuk 1 key tombol. Prioritas: (1) hasil "tangkap otomatis" lewat
// fitur admin "🎨 Kelola Emoji ID" (tersimpan persisten di data/db.json), lalu
// (2) ID yang ditempel manual di object EMOJI_IDS di atas. Balikin null kalau
// dua-duanya kosong, supaya pemanggilnya (withButtonIcon() di bot.js) tahu
// harus skip field icon_custom_emoji_id sama sekali - bukan ngirim string
// kosong ke Telegram (yang bisa bikin error validasi field).
function iconFor(key) {
  const db = require('./db');
  const fromDb = db.getEmojiId(`menu:${key}`);
  if (fromDb) return fromDb;
  const id = EMOJI_IDS[key];
  return id ? id : null;
}

module.exports = { EMOJI_IDS, iconFor };
