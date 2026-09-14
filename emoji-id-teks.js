// ============================================================
// CUSTOM EMOJI ID — TEKS PESAN (bukan tombol)
// ============================================================
// Isi ID-nya LANGSUNG di file ini (bukan lewat .env). Dipakai untuk
// custom emoji "⚡" yang muncul DI DALAM teks pesan lewat tag HTML
// <tg-emoji emoji-id="...">⚡</tg-emoji> — beda mekanisme dari emoji
// di ikon tombol inline (lihat emoji-id-menu-inline.js).
//
// Ada 2 titik pemakaian, boleh diisi ID yang beda:
// - EMOJI_ID_PRODUCT_DESC -> HANYA untuk bullet legacy "{e}" di deskripsi
//   produk & how-to-use. Emoji premium LAIN yang owner pilih langsung dari
//   panel Telegram Premium-nya saat ngetik deskripsi/how-to-use TIDAK butuh
//   ID ini - itu ke-capture otomatis dari pesan owner sendiri (lihat fungsi
//   embedOwnerCustomEmoji() di bot.js). ID ini boleh dikosongkan kalau kamu
//   tidak pakai bullet "{e}" sama sekali.
// - EMOJI_ID_MENU_NOTIF   -> teks menu/notifikasi: welcome, order
//   berhasil, admin panel, dll.
//
// ⚠️ SYARAT WAJIB (Telegram Bot API 9.4, rilis 9 Feb 2026):
// Bot HANYA boleh pakai custom emoji di teks kalau akun PEMILIK BOT
// (bukan bot-nya) punya langganan Telegram Premium aktif. Kalau
// owner belum Premium / ID dikosongkan, otomatis fallback ke emoji
// unicode biasa "⚡" - bot tetap jalan normal, TIDAK ERROR.
//
// Cara dapat custom_emoji_id:
// 1. Kirim custom emoji yang mau dipakai ke @userinfobot atau
//    @RawDataBot (kirim dari akun Premium supaya custom emoji-nya
//    beneran ke-attach sebagai entity, bukan cuma tampil sebagai
//    teks biasa).
// 2. Lihat field "custom_emoji_id" di entities pesan tsb.
// 3. Tempel ID-nya (angka panjang, contoh: "5373141891321699086")
//    ke variabel di bawah, di antara tanda kutip.
// ============================================================

// <- Tempel custom_emoji_id di sini (contoh: '5373141891321699086')
const EMOJI_ID_PRODUCT_DESC = '';

// <- Tempel custom_emoji_id di sini (boleh sama/beda dari yang di atas)
const EMOJI_ID_MENU_NOTIF = '';

// ============================================================
// BACKUP — SEMUA custom emoji ID "teks:*" (per key halaman)
// ============================================================
// Ini SALINAN BACKUP dari data/db.json.emojiIds (key "teks:xxx"), yang
// ke-capture otomatis lewat admin "🎨 Kelola Emoji ID" -> "✍️ Emoji di
// Teks Pesan". Fungsi teksEmoji(key, fallback) di bot.js SAAT INI hanya
// baca dari data/db.json langsung - object di bawah TIDAK otomatis
// kepakai bot, jadi kalau db.json hilang/kereset, tinggal tempel ulang
// isi object ini ke data/db.json.emojiIds (dengan prefix "teks:") untuk
// memulihkannya, atau minta bantuan hubungkan sebagai fallback kedua
// di bot.js seperti mekanisme EMOJI_IDS di emoji-id-menu-inline.js.
const EMOJI_ID_TEKS_BACKUP = {
  welcome_wave: "5316544208159390529",
  // 5 slot baru di bawah ini SENGAJA diisi dengan ID yang SUDAH ADA & sudah
  // kepakai di halaman lain (bukan ID baru) - supaya begitu owner update
  // kode ini, teks welcome langsung tampil dengan emoji Premium yang sama
  // gaya/setnya dengan tombol menu utama & halaman lain, TANPA admin perlu
  // forward ulang emoji manapun lewat "🎨 Kelola Emoji ID". Kalau nanti mau
  // ganti ke emoji lain, tetap bisa lewat admin panel seperti biasa (hasil
  // override dari situ selalu menang - lihat prioritas di teksEmoji()).
  welcome_cart: "5472401690793614752",   // sama dengan tombol menu "🛒 Buy Produk" (menu:buy_produk)
  welcome_wallet: "5267300544094948794", // sama dengan tombol menu "💳 Wallet" & teks "wallet_title"
  welcome_bolt: "6267008582294705964",   // sama dengan ikon "✅ Otomatis" di usdt_auto/ton_auto
  welcome_gift: "5449800250032143374",   // sama dengan tombol menu "🎁 Refer & Earn" & teks referral_title
  welcome_arrow: "5440841102871517055",  // sama dengan tombol "Beli Sekarang" (menu:buy_now)
  profile_title: "5249053508681883137",
  profile_nama: "5305729205630155413",
  profile_username: "5222444124698853913",
  profile_chatid: "5837071798935492251",
  profile_saldo: "6086980694460861135",
  profile_order: "5444856076954520455",
  profile_referral: "5449800250032143374",
  balance_line: "5332600543963522398",
  referral_title: "5449800250032143374",
  referral_reward: "5188605164000395914",
  referral_link: "5271604874419647061",
  referral_howitworks: "5361924463241739687",
  referral_total: "5944970130554359187",
  referral_earnings: "5188605164000395914",
  success_border: "5422439311196834318", // sama dengan channelnotif_border/qris_tip/forcejoin_sparkle (nuansa ✨ dekorasi/pembuka) - lihat catatan di buildSuccessText() (bot.js)
  success_title: "5461151367559141950",
  success_delivered: "4951848493422478932",
  success_link: "4916086774649848789",
  success_manual: "5447644880824181073",
  success_thanks: "5197317659779159705",
  qris_title: "6084682277072144595",
  qris_rocket: "5188481279963715781",
  qris_orderid: "5444856076954520455",
  qris_saldo: "5188605164000395914",
  qris_total: "5278467510604160626",
  qris_expire: "6084396322444544568",
  qris_carabayar: "5472367477084134145",
  qris_step1: "6109505856603165125",
  qris_step2: "5343633090881264367",
  qris_step3: "5352533972515562491",
  qris_auto: "5456140674028019486",
  qris_tip: "5422439311196834318",
  usdt_title: "5292125588209804353",
  usdt_max: "5382164415019768638",
  usdt_min: "5382164415019768638",
  usdt_address_label: "5292125588209804353",
  usdt_auto: "6267008582294705964",
  ton_title: "5834757434333208303",
  ton_min: "5834448733558808898",
  ton_max: "5834448733558808898",
  ton_address_label: "5834535964344590817",
  ton_auto: "6267008582294705964",
  wallet_title: "5267300544094948794",
  orders_empty: "5444856076954520455",
  howto_title: "6084894182168594918",
  qris_creating: "5427181942934088912",
  usdt_prompt: "5292125588209804353",
  qty_stock: "5780714685481357611",
  qty_warning: "5285139029333919650",
  support_title: "5404435834789187002",
  qris_choose_amount_title: "4999349087959515856",
  ton_prompt: "5834448733558808898",
  order_confirm_title: "6084858911897160230",
  order_confirm_balance: "5463219974132746636",
  order_confirm_stock: "5469641199348363998",
  insufficient_balance_warn: "5285139029333919650",
  insufficient_balance_shortfall: "5463219974132746636",

  // --- Blok "Diskon Grosir/Bulk Discount" (BARU) ---
  // Sebelumnya 🎉 & ✅ di sini HARDCODE unicode biasa langsung di lang.js
  // (bulk_discount_title/bulk_discount_line) - jadi TIDAK PERNAH bisa tampil
  // premium walau ikon lain di halaman "Enter Quantity" yang sama (⚠️/📦)
  // sudah premium. Sekarang lewat teksEmoji() juga (lihat tiersText() di
  // bot.js) - sengaja PINJAM ID yang SUDAH ADA & sudah kepakai di tempat lain
  // (bukan ID baru) supaya begitu owner update kode ini, langsung tampil
  // premium tanpa perlu forward ulang emoji manapun: bulk_title pinjam dari
  // success_title (🎉 judul "ORDER BERHASIL"), bulk_check pinjam dari
  // forcejoin_check (✅ ikon centang wajib-join). Tetap bisa diganti terpisah
  // kapan saja lewat admin "🎨 Kelola Emoji ID" -> "✍️ Emoji di Teks Pesan"
  // (hasil override dari situ selalu menang - lihat prioritas di teksEmoji()).
  bulk_title: "5461151367559141950", // sama dengan success_title (🎉)
  bulk_check: "6267008582294705964", // sama dengan forcejoin_check/welcome_bolt (✅)

  // --- Layar Wajib Join Channel ---
  // Sama seperti slot welcome_* di atas: sengaja diisi ID yang SUDAH ADA &
  // sudah kepakai di teks/halaman lain (bukan ID baru), dicocokkan
  // berdasarkan NUANSA/fungsinya - supaya begitu owner update kode ini,
  // layar wajib-join langsung tampil dengan gaya emoji Premium yang sama
  // dengan halaman lain, TANPA admin perlu forward ulang emoji manapun.
  forcejoin_lock: "5285139029333919650",     // sama dengan qty_warning/insufficient_balance_warn (nuansa "wajib diperhatikan dulu")
  forcejoin_sparkle: "5422439311196834318",  // sama dengan qris_tip (nuansa kalimat pembuka/tip)
  forcejoin_bolt: "6267008582294705964",     // sama dengan welcome_bolt/usdt_auto/ton_auto (nuansa "cepat/otomatis")
  forcejoin_arrow: "5440841102871517055",    // sama dengan welcome_arrow/buy_now (nuansa "arahan aksi berikutnya")
  forcejoin_check: "6267008582294705964",    // sama dengan welcome_bolt (ikon centang "✅ Otomatis")
  forcejoin_status_joined: "6267008582294705964",  // ✅ sama dengan checkmark di atas
  forcejoin_status_pending: "5285139029333919650", // sama dengan ikon peringatan qty_warning (belum selesai)

  // --- Notifikasi Channel Otomatis (New Purchase / New Wallet Top-Up) ---
  // Sama seperti grup slot lain di atas: sengaja diisi ID yang SUDAH ADA &
  // sudah kepakai di teks/tombol lain (bukan ID baru), dicocokkan berdasarkan
  // NUANSA/fungsinya - supaya begitu owner update kode ini, notifikasi
  // channel langsung tampil pakai emoji Premium yang sama gaya/setnya dengan
  // halaman lain, TANPA admin perlu forward ulang emoji manapun. Tetap bisa
  // diganti kapan saja lewat admin "🎨 Kelola Emoji ID" -> "✍️ Emoji di Teks
  // Pesan" -> "📢 Notifikasi Channel" (hasil override dari situ selalu menang).
  channelnotif_purchase_title: "5461151367559141950", // sama dengan success_title (🎉 New Purchase!)
  channelnotif_id: "5444856076954520455",             // sama dengan qris_orderid (nuansa "ID/nomor referensi")
  channelnotif_product: "5472401690793614752",        // sama dengan welcome_cart (🛒 Product)
  channelnotif_qty: "5780714685481357611",            // sama dengan qty_stock (nuansa jumlah/kuantitas)
  channelnotif_total: "5278467510604160626",          // sama dengan qris_total (💰 Total)
  channelnotif_time: "6084396322444544568",           // sama dengan qris_expire (nuansa waktu/durasi)
  channelnotif_topup_title: "5267300544094948794",    // sama dengan welcome_wallet (💳 New Wallet Top-Up!)
  channelnotif_network: "6267008582294705964",        // sama dengan welcome_bolt/usdt_auto (✅ status otomatis/terverifikasi)
  channelnotif_amount: "5188605164000395914",         // sama dengan qris_saldo (💵 nominal yang masuk)
  channelnotif_referral_title: "5461151367559141950",    // sama dengan success_title/channelnotif_purchase_title (🎉 New Referral Success!)
  channelnotif_referral_user: "5249053508681883137",     // sama dengan profile_title (👤 baris User)
  channelnotif_referral_referredby: "5449800250032143374", // sama dengan referral_title/welcome_gift (🎁 baris Referred By)
  channelnotif_referral_reward: "5188605164000395914",   // sama dengan channelnotif_amount/qris_saldo (💵 baris Reward)

  // --- Border & footer notifikasi channel (BARU) ---
  // Sebelumnya karakter "✨" di garis pembatas atas/bawah judul, dan "🔥" di
  // baris footer "Fast & Trusted!", HARDCODE langsung di teks (bukan lewat
  // teksEmoji()) - jadi TIDAK PERNAH bisa tampil premium walau ID lain di
  // notifikasi channel ini sudah premium semua. Sekarang keduanya sudah lewat
  // teksEmoji() juga (lihat buildChannelPurchaseText/TopupText/ReferralText
  // di bot.js), supaya SELURUH ikon di notifikasi channel konsisten premium.
  channelnotif_border: "5422439311196834318", // sama dengan qris_tip/forcejoin_sparkle (nuansa ✨ dekorasi/pembuka)
  // FIX BUG: sebelumnya dikosongkan ("") -> footer 🔥 SELALU tampil unicode
  // biasa walau ikon lain di notif channel sudah premium, karena teksEmoji()
  // cuma treat string kosong sebagai "tidak ada ID" (lihat `id ? ... : fallback`
  // di teksEmoji()). Sekarang dipinjamkan ID yang sama dengan welcome_bolt/
  // usdt_auto/ton_auto/forcejoin_bolt (nuansa "cepat/otomatis" - cocok untuk
  // tagline "Fast & Trusted!"/"Instant & Automatic!"), sama seperti pola
  // pinjam-ID di slot lain pada object ini. Tetap bisa diganti kapan saja
  // lewat admin "🎨 Kelola Emoji ID" -> "✍️ Emoji di Teks Pesan" -> "📢
  // Notifikasi Channel" -> "Ikon Footer 🔥" (hasil override dari situ selalu menang).
  channelnotif_footer: "6267008582294705964",

  // --- Notifikasi Channel: Maintenance Dimulai/Selesai (BARU) ---
  // Sama pola dengan slot channelnotif_* lain di atas: sengaja pinjam ID
  // yang SUDAH ADA & sudah kepakai di tempat lain (bukan ID baru),
  // dicocokkan berdasarkan NUANSA - supaya begitu owner update kode ini,
  // notifikasi maintenance ke channel langsung tampil pakai emoji Premium
  // yang sama gaya/setnya. Dipakai oleh buildChannelMaintenanceText() &
  // handler 'maintenance_toggle' di bot.js. Tetap bisa diganti kapan saja
  // lewat admin "🎨 Kelola Emoji ID" -> "✍️ Emoji di Teks Pesan" -> "📢
  // Notifikasi Channel" (hasil override selalu menang).
  channelnotif_maintenance_start_title: "5285139029333919650",  // sama dengan maintenance_wrench/qty_warning (nuansa "perlu perhatian")
  channelnotif_maintenance_start_status: "6084396322444544568", // sama dengan maintenance_clock/qris_expire (nuansa waktu/durasi/sementara)
  channelnotif_maintenance_finish_title: "5188481279963715781", // sama dengan maintenance_finished_rocket/qris_rocket (nuansa "meluncur/comeback")
  channelnotif_maintenance_finish_status: "6267008582294705964", // sama dengan welcome_bolt/forcejoin_check (✅ status "selesai/otomatis")

  // --- Mode Maintenance Bot (BARU) ---
  // Sama seperti grup slot lain di atas: sengaja dipinjamkan ID yang SUDAH
  // ADA & sudah kepakai di teks/halaman lain (bukan ID baru), dicocokkan
  // berdasarkan NUANSA/fungsinya - supaya begitu owner aktifkan "🛠️
  // Maintenance Bot" dari admin panel, pesannya langsung tampil pakai emoji
  // Premium yang sama gaya/setnya dengan halaman lain, TANPA admin perlu
  // forward ulang emoji manapun. Tetap bisa diganti kapan saja lewat admin
  // "🎨 Kelola Emoji ID" -> "✍️ Emoji di Teks Pesan" -> "🛠️ Mode Maintenance"
  // (hasil override dari situ selalu menang - lihat prioritas di teksEmoji()).
  maintenance_wrench: "5285139029333919650",  // sama dengan qty_warning/forcejoin_lock (nuansa "perlu perhatian")
  maintenance_sparkle: "5422439311196834318", // sama dengan qris_tip/forcejoin_sparkle/success_border (nuansa ✨ dekorasi/pembuka)
  maintenance_bolt: "6267008582294705964",    // sama dengan welcome_bolt/usdt_auto (nuansa "cepat/otomatis")
  maintenance_clock: "6084396322444544568",   // sama dengan qris_expire (nuansa waktu/durasi)
  maintenance_heart: "5197317659779159705",   // sama dengan success_thanks (nuansa ucapan/apresiasi)

  // --- Mode Maintenance SELESAI (BARU) --- dipakai saat admin nonaktifkan
  // Maintenance dari "🔴 Nonaktifkan", broadcast otomatis ke SEMUA user
  // (lihat buildMaintenanceFinishedText() & handler 'maintenance_toggle' di
  // bot.js). Sama seperti grup lain: sengaja pinjam ID yang SUDAH ADA &
  // sudah kepakai di tempat lain (bukan ID baru), dicocokkan berdasarkan
  // NUANSA "comeback/selesai/perayaan" - supaya begitu owner update kode
  // ini, broadcast langsung tampil pakai emoji Premium yang sama gaya/setnya
  // dengan halaman lain, TANPA admin perlu forward ulang emoji manapun.
  // Tetap bisa diganti kapan saja lewat admin "🎨 Kelola Emoji ID" -> "✍️
  // Emoji di Teks Pesan" -> "🛠️ Mode Maintenance" (hasil override selalu menang).
  maintenance_finished_rocket: "5188481279963715781", // sama dengan qris_rocket (nuansa "meluncur/comeback")
  maintenance_finished_sparkle: "5422439311196834318", // sama dengan maintenance_sparkle/qris_tip (nuansa ✨ dekorasi/pembuka)
  maintenance_finished_check: "6267008582294705964",   // sama dengan welcome_bolt/forcejoin_check (✅ status "selesai/otomatis")
  maintenance_finished_bolt: "6267008582294705964",    // sama dengan welcome_bolt/usdt_auto (nuansa "cepat/otomatis")
  maintenance_finished_gift: "5449800250032143374",    // sama dengan welcome_gift/referral_title (🎁 nuansa "bisa dipakai lagi/reward")
  maintenance_finished_heart: "5197317659779159705",   // sama dengan maintenance_heart/success_thanks (nuansa ucapan/apresiasi)
};

module.exports = {
  EMOJI_ID_PRODUCT_DESC: EMOJI_ID_PRODUCT_DESC || null,
  EMOJI_ID_MENU_NOTIF: EMOJI_ID_MENU_NOTIF || null,
  EMOJI_ID_TEKS_BACKUP
};
