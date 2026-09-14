// ============================================================
// MODUL BAHASA (i18n) — Indonesia & English
// ============================================================
// Semua teks & label tombol yang bisa diganti bahasanya taruh di sini,
// supaya bot.js tinggal manggil t(chatId, 'key', {vars}) dan tidak perlu
// hardcode string per-bahasa di banyak tempat.
//
// Cara pakai di bot.js:
//   const { t, tr, LANGS, languageKeyboard } = require('./lang');
//   t(chatId, 'welcome', { store: STORE_NAME })   -> otomatis pakai bahasa user
//   tr('en', 'welcome', { store: STORE_NAME })    -> paksa bahasa tertentu
// ============================================================

const db = require('./db');

const LANGS = {
  id: { code: 'id', label: '🇮🇩 Indonesia' },
  en: { code: 'en', label: '🇬🇧 English' }
};

const DICT = {
  id: {
    choose_language: '🌐 Silakan pilih bahasa yang ingin kamu gunakan:',
    language_changed: '✅ Bahasa berhasil diganti ke <b>Indonesia</b>.',
    btn_language: '🌐 Bahasa',

    welcome: '⚡ <b>{store}</b> — akun premium, harga bersahabat.\n\n<blockquote>{cart_icon} Netflix, Spotify, Gemini, CapCut, dan ratusan lainnya.\n{bolt_icon} Bayar, langsung terkirim — <b>auto</b>, tanpa nunggu admin.\n{wallet_icon} Topup saldo otomatis lewat QRIS, USDT, atau TON.\n{gift_icon} Ajak teman, cuan jalan lewat <b>Refer & Earn</b>.</blockquote>\n\n{arrow_icon} Gas, pilih menu di bawah!',
    referral_success: '🎉 Referral berhasil! Temanmu yang gabung lewat link kamu baru saja top-up saldo pertamanya.\n💰 Kamu mendapat tambahan saldo <b>{amount}</b>.\n💼 Saldo sekarang: <b>{balance}</b>',

    btn_buy_product: '🛒 Buy Produk',
    btn_profile: '👤 Profile',
    btn_balance: '💰 Saldo Saya',
    btn_wallet: '💳 Wallet',
    btn_orders: '🧾 My Orders',
    btn_howto: '❗️ How to Use',
    btn_support: '📞 Support',
    btn_referral: '🎁 Refer & Earn',
    btn_back: '‹ Kembali',
    btn_go_back: '⬅️ Go Back',

    profile_title: '👤 Profile',
    profile_name: 'Nama',
    profile_username: 'Username',
    profile_username_empty: '<i>belum punya username Telegram</i>',
    profile_chatid: 'Chat ID',
    profile_balance: 'Saldo Wallet',
    profile_orders: 'Total Order',
    profile_referral: 'Total Referral',

    balance_line: '{icon} Saldo kamu saat ini: <b>{balance}</b>',

    topup_title: '{emoji_wallet} <b>Wallet - Topup Saldo</b>\n\nPilih metode pembayaran. Semuanya <b>otomatis</b> - saldo langsung masuk begitu pembayaran terdeteksi, tanpa perlu approve admin.',
    btn_topup_qris: '📱 QRIS (Otomatis)',
    btn_topup_usdt: '💵 USDT - BEP20 (Otomatis)',
    btn_topup_ton: '💎 TON / Gram (Otomatis)',

    orders_empty: '{emoji_orders} Kamu belum punya riwayat pembelian.',
    orders_title: '<b>Riwayat Order Kamu:</b>',
    order_id_label: 'Order ID',
    order_product_label: 'Produk',
    order_status_label: 'Status',
    btn_recover: '🏅 Recover Product',
    btn_cancel: '❌ Batal',
    recover_title: '🏅 <b>Recover Product</b>\n\nKetik Order ID yang mau kamu recover (lihat di daftar My Orders di atas), nanti bot kirim ulang link/kode yang sudah pernah terkirim.',
    recover_result_title: 'Recover Product',

    howto_title: '{emoji_howto} <b>How it works</b>\n\nPilih produk di bawah ini untuk lihat panduan langkah demi langkah cara pakainya:',
    btn_close_menu: '❌ Tutup menu',

    support_title: '{emoji_support} <b>Support Center</b>\n\nKalau butuh bantuan, silakan pencet tombol di bawah ini untuk hubungi tim support kami.',
    support_title_noadmin: '{emoji_support} <b>Support Center</b>\n\n⚠️ Admin belum mengisi konfigurasi admin, jadi tombol contact support belum bisa ditampilkan.',
    btn_contact_support: '📞 Contact Support',

    referral_title: '<b>Refer &amp; Earn Program</b>',
    referral_disabled: '⚠️ Fitur ini belum aktif karena username bot belum diisi. Minta admin isi dulu username bot supaya link referral bisa dibuat.',
    referral_body: 'Ajak temanmu belanja di <b>{store}</b> dan dapatkan saldo langsung ke Wallet kamu!\n\n{reward_emoji} <b>Reward per Referral:</b> {reward}\n\n{link_emoji} <b>Link Referral Kamu:</b>\n<code>{link}</code>\n\n<blockquote>{how_emoji} <b>Cara Kerjanya:</b>\n1. Bagikan link referral kamu\n2. Temanmu buka bot lewat link itu\n3. Begitu temanmu top-up saldo pertama kalinya, saldo kamu otomatis bertambah!</blockquote>\n\n{total_emoji} <b>Total Referral:</b> {count}\n{earnings_emoji} <b>Total Penghasilan Referral:</b> {earnings}',
    btn_share_referral: '📤 Bagikan Link Referral',
    btn_copy_referral: '📋 Copy Refer Link',

    // ---- Gift (Buy Gift / Confess Gift, via userbot GramJS - lihat userbot.js) ----
    btn_gift_menu: '🎁 Buy Gift / Confess Gift',
    gift_not_configured: '⚠️ Fitur Gift belum dikonfigurasi admin (USERBOT_SESSION kosong).',
    gift_mode_title: '🎁 <b>Buy Gift / Confess Gift</b>\n\nPilih mode pengiriman gift-nya dulu:\n\n🎁 <b>Buy Gift</b> - gift dikirim atas nama akun toko, TANPA pesan.\n💌 <b>Confess Gift</b> - gift + pesan anonim yang kamu ketik sendiri, identitas kamu <b>disembunyikan</b> dari penerima.',
    btn_gift_buy: '🎁 Buy Gift',
    btn_gift_confess: '💌 Confess Gift',
    gift_list_title_buy: '🎁 <b>Buy Gift</b>\n\nPilih hadiah di bawah untuk dikirim ke user Telegram manapun (cukup username atau ID-nya).',
    gift_list_title_confess: '💌 <b>Confess Gift</b>\n\nPilih hadiah di bawah, lalu kirim ke siapapun beserta pesan anonim. Identitas kamu <b>disembunyikan</b> dari penerima.',
    gift_not_found: '⚠️ Gift tidak ditemukan / sudah habis, coba lagi.',
    gift_detail_price_line: '💰 Harga: {price}',
    gift_ask_target: 'Kirim username atau ID Telegram tujuan (tanpa @):',
    gift_invalid_target: '⚠️ Username/ID tidak valid, kirim ulang (contoh: <code>username</code> atau <code>123456789</code>).',
    gift_ask_message: '💌 Ketik pesan anonim yang mau ikut dikirim bersama gift (maks 250 karakter):',
    gift_confirm_title: '🧾 <b>Konfirmasi {mode}</b>',
    gift_confirm_gift_line: '🎁 Gift: {stars}⭐',
    gift_confirm_target_line: '🎯 Tujuan: <code>{target}</code>',
    gift_confirm_message_line: '💌 Pesan: "{message}"',
    gift_confirm_hidden_notice: 'Identitas kamu <b>tidak akan terlihat</b> oleh penerima.',
    btn_gift_send_now: '✅ Kirim Sekarang',

    products_title: '📦 <b>Produk Tersedia</b>\nSilakan pilih produk untuk lanjut:',
    variant_choose: 'Pilih varian:',
    product_not_found: 'Produk tidak ditemukan.',
    btn_how_to_use: '❗️ How to Use',
    btn_buy_now: '✅ Buy Now',

    howto_not_available: 'Belum ada panduan cara pakai untuk produk ini. Hubungi admin kalau ada kendala.',
    howto_page_title: '❗️ <b>Cara Pakai - {product}</b>',

    qty_custom: '✏️ Jumlah Custom',
    order_confirm_title: '{title_icon} <b>Order Confirmation</b>',
    btn_place_order: '💰 Place Order',
    btn_cancel_order: '❌ Cancel Order',

    btn_cancel_arrow: '⬅️ Batal',
    topup_qris_not_configured: '⚠️ Pembayaran QRIS belum dikonfigurasi admin (`PAYKITA_API_KEY` kosong di `.env`).',
    topup_usdt_not_configured: '⚠️ Pembayaran USDT (BEP20) belum dikonfigurasi admin (`USDT_BEP20_ADDRESS` kosong di `.env`).',
    topup_ton_not_configured: '⚠️ Pembayaran TON belum dikonfigurasi admin (`TON_ADDRESS` kosong di `.env`).',
    topup_binance_not_configured: '⚠️ Pembayaran Binance Pay belum dikonfigurasi admin (`BINANCE_API_KEY`/`BINANCE_PAY_ID` kosong di `.env`).',

    qris_choose_amount_title: '{emoji_qris_amount} <b>PILIH NOMINAL DEPOSIT</b>\n\nSilakan pilih nominal deposit instan di bawah ini, atau gunakan Nominal Kustom:',
    btn_custom_amount: '✏️ Nominal Kustom',
    qris_custom_prompt: '✏️ *Nominal Kustom*\n\nKetik nominal topup dalam USD (angka saja, boleh pakai desimal, minimal {min}), contoh: `5` atau `5.25`.',
    qris_creating: '{emoji_hourglass} Sedang membuat QRIS untuk nominal <b>{amount}</b>...',
    toast_creating_qris: '⏳ Membuat QRIS...',
    toast_creating_usdt_invoice: '⏳ Membuat invoice USDT...',
    toast_creating_ton_invoice: '⏳ Membuat invoice TON...',
    toast_creating_binance_invoice: '⏳ Membuat invoice Binance Pay...',
    qris_invalid_amount: 'Nominal tidak valid.',
    qris_too_small: '⚠️ Nominal terlalu kecil untuk QRIS (minimal {min}). Ketik nominal USD yang lebih besar.',
    qris_create_failed: '⚠️ Gagal membuat QRIS pembayaran saat ini. Coba lagi beberapa saat lagi, atau hubungi admin.',
    qris_invoice_caption: '{title_icon} <b>TAGIHAN QRIS KAMU SUDAH SIAP!</b>\n━━━━━━━━━━━━━━━━━━\n\nTinggal satu langkah lagi menuju saldo penuh, gan! {rocket_icon}\n\n{orderid_icon} Order ID: <code>{orderId}</code>\n{saldo_icon} Saldo yang didapat: <b>{amount}</b>\n{total_icon} Total bayar via QRIS: <b>{total}</b>\n{expire_icon} Berlaku selama: <b>10 menit</b>\n\n{carabayar_icon} <b>Cara bayar:</b>\n{step1_icon} Buka aplikasi e-wallet / mobile banking favoritmu\n{step2_icon} Pilih menu <b>Scan QR</b> / <b>QRIS</b>\n{step3_icon} Scan QR di atas, lalu bayar sesuai nominal <b>persis</b> ({total}) — jangan dibulatkan\n\n{auto_icon} Saldo Wallet masuk <b>OTOMATIS</b> detik itu juga begitu pembayaran terdeteksi — tidak perlu konfirmasi ke admin, tidak perlu nunggu!\n\n{tip_icon} Berubah pikiran? Tinggal pencet tombol <b>Batalkan Pembayaran</b> di bawah.',
    qris_qr_send_failed: '\n\n⚠️ Gagal menampilkan gambar QR, hubungi admin dengan menyertakan Order ID di atas.',
    qris_expired: '⌛ QRIS topup `{id}` kedaluwarsa (belum ada pembayaran masuk dalam 10 menit). Silakan ulangi topup kalau masih ingin lanjut.',
    qris_paid: '✅ Pembayaran QRIS diterima!\nSaldo Wallet bertambah *{amount}*.\n💼 Saldo sekarang: *{balance}*',
    btn_qris_cancel: '❌ Batalkan Pembayaran',
    toast_payment_cancelled: 'Pembayaran dibatalkan.',
    toast_topup_cancelled: 'Topup dibatalkan.',

    usdt_topup_prompt: '{emoji_usdt} <b>Topup via USDT (BEP20)</b>\n\nKetik nominal topup dalam USD (angka saja, boleh pakai desimal, minimal {min}, maksimal {max}), akan diproses sebagai USDT 1:1. Contoh: <code>50</code> atau <code>50.25</code>',
    usdt_invoice_text: '{title_icon} <b>Deposit via USDT (BEP20)</b>\n\n{min_icon} <b>Min Deposit:</b> {min}\n{max_icon} <b>Max Deposit:</b> {max}\n\nOrder ID: <code>{orderId}</code>\n\nKirim <b>PERSIS</b> jumlah ini (jangan dibulatkan):\n<code>{uniqueAmount}</code> USDT\n\n{address_icon} <b>Address</b> (jaringan <b>BEP20 / BNB Smart Chain</b> SAJA):\n<code>{address}</code>\n\n⚠️ <b>Penting:</b>\n• Nominal harus PERSIS sama sampai 4 desimal supaya sistem bisa mencocokkan otomatis ke deposit kamu.\n• WAJIB pakai jaringan BEP20 (BSC). Kirim dari jaringan lain berisiko dana hilang.\n\n{auto_icon} <b>Automatic Deposit:</b> Saldo Wallet masuk otomatis dalam 1-2 menit setelah transaksi terkonfirmasi di blockchain. Tidak perlu kirim Tx Hash manual.\n\n⏳ Berlaku 30 menit.',
    btn_copy_address: '📋 Copy Address',
    btn_usdt_cancel: '❌ Batalkan Topup',
    usdt_expired: '⌛ Topup USDT `{id}` kedaluwarsa. Silakan ulangi topup kalau masih ingin lanjut.',
    usdt_paid: '✅ Pembayaran USDT diterima!\nTx Hash: `{hash}`\nSaldo Wallet bertambah *{amount}*.\n💼 Saldo sekarang: *{balance}*',

    ton_topup_prompt: '{emoji_ton} <b>Topup via TON (The Open Network)</b>\n\nKetik nominal topup dalam USD (angka saja, boleh pakai desimal, minimal {min}, maksimal {max}), akan otomatis dikonversi ke TON pakai kurs live. Contoh: <code>5</code> atau <code>5.25</code>',
    ton_invoice_text: '{title_icon} <b>Deposit via TON (The Open Network)</b>\n\n{min_icon} <b>Min Deposit:</b> {min}\n{max_icon} <b>Max Deposit:</b> {max}\n\nOrder ID: <code>{orderId}</code>\n\nKirim <b>PERSIS</b> jumlah ini (jangan dibulatkan):\n<code>{uniqueAmount}</code> TON\n\n{address_icon} <b>Address</b> (jaringan <b>TON</b> asli SAJA):\n<code>{address}</code>\n\n⚠️ <b>Penting:</b>\n• Nominal harus PERSIS sama sampai 4 desimal supaya sistem bisa mencocokkan otomatis ke deposit kamu.\n• Kirim langsung dari wallet TON (Tonkeeper, Tonhub, dll), JANGAN dari exchange yang memotong/membulatkan nominal kirim.\n\n{auto_icon} <b>Automatic Deposit:</b> Saldo Wallet masuk otomatis dalam 1-2 menit setelah transaksi terkonfirmasi di blockchain. Tidak perlu kirim Tx Hash manual.\n\n⏳ Berlaku 30 menit.',
    btn_ton_cancel: '❌ Batalkan Topup',
    ton_expired: '⌛ Topup TON `{id}` kedaluwarsa. Silakan ulangi topup kalau masih ingin lanjut.',
    ton_paid: '✅ Pembayaran TON diterima!\nSaldo Wallet bertambah *{amount}*.\n💼 Saldo sekarang: *{balance}*',

    btn_topup_binance: 'Binance Pay (Otomatis)',
    binance_topup_prompt: '{emoji_binance} <b>Topup via Binance Pay</b>\n\nKetik nominal topup dalam USD (angka saja, boleh pakai desimal, minimal {min}, maksimal {max}), akan diproses 1:1. Contoh: <code>10</code> atau <code>10.5</code>',
    binance_invoice_text: '{title_icon} <b>Deposit via Binance Pay</b>\n\n{min_icon} <b>Min Deposit:</b> {min}\n{max_icon} <b>Max Deposit:</b> {max}\n\nOrder ID: <code>{orderId}</code>\n\nKirim <b>PERSIS</b> jumlah ini dalam <b>USDT</b> lewat menu <b>Pay</b> di app Binance (jangan dibulatkan, dan jangan pakai aset lain):\n<code>{uniqueAmount}</code>\n\n{payid_icon} <b>Binance ID</b> tujuan (tap untuk copy):\n<code>{payId}</code>\n\n⚠️ <b>Penting:</b>\n• Nominal harus PERSIS sama sampai 4 desimal, dan asetnya WAJIB USDT - transfer aset lain (BNB, BUSD, dll) TIDAK akan terdeteksi otomatis walau angkanya sama persis.\n• Kirim lewat menu <b>Pay -&gt; Send</b> ke Binance ID di atas, BUKAN P2P/transfer biasa.\n\n{auto_icon} <b>Automatic Deposit:</b> Saldo Wallet masuk otomatis dalam 1-2 menit setelah transaksi terdeteksi di histori Binance Pay. Tidak perlu kirim bukti/Order ID manual ke admin.\n\n⏳ Berlaku 30 menit.',
    btn_copy_binance_id: '📋 Copy Binance ID',
    btn_binance_cancel: '❌ Batalkan Topup',
    binance_expired: '⌛ Topup Binance Pay `{id}` kedaluwarsa. Silakan ulangi topup kalau masih ingin lanjut.',
    binance_paid: '✅ Pembayaran Binance Pay diterima!\nRef: `{id}`\nSaldo Wallet bertambah *{amount}*.\n💼 Saldo sekarang: *{balance}*',

    pending_min_amount: '⚠️ Nominal minimal {min}. Ketik ulang nominal USD-nya (angka saja, boleh desimal).',
    pending_min_amount_generic: '⚠️ Nominal minimal {min}. Ketik ulang nominalnya (angka saja, boleh desimal).',
    pending_max_amount: '⚠️ Nominal maksimal {max}. Ketik ulang nominalnya (angka saja, boleh desimal).',

    order_not_found: 'Order tidak ditemukan.',
    variant_not_found: 'Varian tidak ditemukan.',
    product_variant_not_found: 'Produk/varian tidak ditemukan.',
    recover_item_not_recoverable: 'Item order ini tidak bisa di-recover.',
    totp_refreshed: '🔄 Kode 2FA diperbarui.',
    btn_refresh_2fa: '🔄 Refresh Kode 2FA',
    out_of_stock: '❌ Stok habis, silakan pilih produk lain.',
    ask_custom_qty: '✏️ Ketik jumlah yang ingin kamu beli (angka saja):',
    invalid_qty: '⚠️ Jumlah tidak valid.',
    invalid_qty_number: '⚠️ Masukkan jumlah yang valid (angka saja).',
    not_enough_stock: 'Stok tidak cukup. Sisa stok: {stock}',
    supplier_order_failed: '⚠️ Stok sedang tidak tersedia dari supplier, coba lagi sebentar lagi. Saldo kamu belum dipotong.',
    supplier_balance_empty: '⚠️ Saldo supplier sedang habis, tim kami sedang mengisi ulang. Silakan coba lagi sebentar lagi. Saldo kamu belum dipotong.',
    insufficient_balance: 'Saldo kamu tidak cukup. Silakan topup dulu.',
    insufficient_balance_shortfall_label: 'Kurang',
    insufficient_balance_cta: 'Topup langsung lewat salah satu metode di bawah:',
    generic_error: 'Terjadi kesalahan.',
    recover_order_not_found: '⚠️ Order ID `{orderId}` tidak ditemukan di akun kamu. Cek lagi ID-nya lewat menu My Orders.',
    recover_no_items: '⚠️ Order `{orderId}` belum ada item yang bisa di-recover (bukan auto-delivered). Hubungi admin untuk bantuan.',
    referral_username_missing: '⚠️ BOT_USERNAME belum diisi admin di .env.',

    enter_qty_title: '<blockquote>{emoji_warning} <b>Masukkan Jumlah</b>\nMau beli berapa pcs {product}?</blockquote>\n\n{tiers}\n\n{emoji_stock} Stok tersedia: <b>{stock}</b>',
    price_per_pcs: 'Harga: <b>{price}</b> / pcs',
    bulk_discount_title: '{emoji_title} <b>Diskon Grosir</b>',
    bulk_discount_line: '{emoji_check} Beli {range} → <b>{price}</b> / pcs',
    desc_fallback: 'Harga mulai {price} / pcs.\nStok tersedia: {stock}',
    live_totp_note: '<i>(live, berlaku ~{seconds} detik lagi)</i>',
    account_label: 'Akun',

    order_confirm_body: 'Produk: {product}\nJumlah: {qty}\nTotal Bayar: <b>{total}</b>\n\n{balance_icon} Saldo Wallet: <b>{balance}</b>\n{stock_icon} Stok Tersedia: <b>{stock}</b>',

    success_title: '🎉 <b>ORDER BERHASIL!</b> 🎉',
    success_product_label: '<b>Produk:</b>',
    success_qty_label: '<b>Jumlah:</b>',
    success_qty_unit: '{qty} pcs',
    success_total_label: '<b>Total Bayar:</b>',
    success_orderid_label: '<b>ID Order:</b>',
    success_delivered_title: '🚀 <b>Produk kamu sudah otomatis dikirim, langsung cek di bawah ini!</b>',
    success_delivered_detail: '🔗 <b>Detail Produk / Redeem:</b>',
    success_manual: '📦 Admin akan segera memproses dan mengirimkan akun/detail ke chat ini secara manual.',
    success_thanks: '🙏 <b>Terima kasih sudah belanja di {store}!</b> Ditunggu order berikutnya ya',

    forcejoin_title: '{lock_icon} <b>SATU LANGKAH LAGI, SOB!</b> {lock_icon}',
    forcejoin_desc: '{sparkle_icon} Gerbang menuju <b>{store}</b> baru bisa kebuka kalau kamu sudah gabung ke channel/grup resmi kami di bawah ini. Gratis, kok — cuma butuh sat set beberapa detik aja! {bolt_icon}\n\n{arrow_icon} Tap tombolnya, join, terus balik ke sini dan pencet <b>"{check_icon} Saya Sudah Join"</b> buat verifikasi otomatis.',
    forcejoin_channel_line: '{status} {title}',
    forcejoin_status_joined: '✅',
    forcejoin_status_pending: '🔸',
    btn_checkjoin: '✅ Saya Sudah Join',
    forcejoin_still_locked: '🚫 Yah, masih ada channel/grup yang belum kamu join nih. Gas join dulu semuanya, baru pencet tombol ini lagi ya!',
    forcejoin_all_joined_toast: '🎉 Mantap, semua channel/grup sudah kamu join! Selamat datang~',
    btn_join_channel: '📢 Join {title}',

    maintenance_title: '{wrench_icon} <b>SEDANG MAINTENANCE</b> {wrench_icon}',
    maintenance_desc: '{sparkle_icon} Halo Sobat <b>{store}</b>! Bot lagi kita upgrade & polish dulu sebentar biar makin ngebut, stabil, dan makin premium buat kalian semua. {bolt_icon}\n\n{clock_icon} Mohon bersabar ya, kita balik lagi secepatnya!\n{heart_icon} Makasih banyak atas pengertiannya 🙏',

    maintenance_finished_title: '{rocket_icon} <b>KAMI SUDAH KEMBALI!</b> {rocket_icon}',
    maintenance_finished_desc: '{sparkle_icon} Yeay, Sobat <b>{store}</b>! Maintenance-nya sudah {check_icon} <b>SELESAI</b> — bot sekarang lebih ngebut, stabil, dan makin premium dari sebelumnya. {bolt_icon}\n\n{gift_icon} Semua fitur sudah bisa dipakai normal lagi, gas order sekarang juga!\n{heart_icon} Makasih banyak sudah sabar nunggu ya 🙏'
  },

  en: {
    choose_language: '🌐 Please choose the language you want to use:',
    language_changed: '✅ Language switched to <b>English</b>.',
    btn_language: '🌐 Language',

    welcome: '⚡ <b>{store}</b> — premium accounts, prices you will love.\n\n<blockquote>{cart_icon} Netflix, Spotify, Gemini, CapCut, and hundreds more.\n{bolt_icon} Pay, get it instantly — <b>auto</b>, no admin needed.\n{wallet_icon} Automatic Wallet topup via QRIS, USDT, or TON.\n{gift_icon} Invite friends and earn via <b>Refer & Earn</b>.</blockquote>\n\n{arrow_icon} Ready to shop? Pick a menu below!',
    referral_success: '🎉 Referral successful! Your friend who joined through your link just topped up their balance for the first time.\n💰 You received an extra <b>{amount}</b> balance.\n💼 Current balance: <b>{balance}</b>',

    btn_buy_product: '🛒 Buy Product',
    btn_profile: '👤 Profile',
    btn_balance: '💰 My Balance',
    btn_wallet: '💳 Wallet',
    btn_orders: '🧾 My Orders',
    btn_howto: '❗️ How to Use',
    btn_support: '📞 Support',
    btn_referral: '🎁 Refer & Earn',
    btn_back: '‹ Back',
    btn_go_back: '⬅️ Go Back',

    profile_title: '👤 Profile',
    profile_name: 'Name',
    profile_username: 'Username',
    profile_username_empty: '<i>no Telegram username yet</i>',
    profile_chatid: 'Chat ID',
    profile_balance: 'Wallet Balance',
    profile_orders: 'Total Orders',
    profile_referral: 'Total Referrals',

    balance_line: '{icon} Your current balance: <b>{balance}</b>',

    topup_title: '{emoji_wallet} <b>Wallet - Add Balance</b>\n\nChoose a payment method. All methods are <b>automatic</b> - your balance is credited instantly once payment is detected, no admin approval needed.',
    btn_topup_qris: '📱 QRIS (Automatic)',
    btn_topup_usdt: '💵 USDT - BEP20 (Automatic)',
    btn_topup_ton: '💎 TON / Gram (Automatic)',

    orders_empty: "{emoji_orders} You don't have any purchase history yet.",
    orders_title: '<b>Your Recent Orders:</b>',
    order_id_label: 'Order ID',
    order_product_label: 'Product',
    order_status_label: 'Status',
    btn_recover: '🏅 Recover Product',
    btn_cancel: '❌ Cancel',
    recover_title: '🏅 <b>Recover Product</b>\n\nType the Order ID you want to recover (see the My Orders list above), and the bot will resend the link/code that was previously delivered.',
    recover_result_title: 'Recover Product',

    howto_title: '{emoji_howto} <b>How it works</b>\n\nSelect a product below to see the step-by-step usage guide:',
    btn_close_menu: '❌ Close menu',

    support_title: '{emoji_support} <b>Support Center</b>\n\nIf you need help, tap the button below to contact our support team.',
    support_title_noadmin: "{emoji_support} <b>Support Center</b>\n\n⚠️ The admin hasn't set up the admin configuration yet, so the contact support button isn't available.",
    btn_contact_support: '📞 Contact Support',

    referral_title: '<b>Refer &amp; Earn Program</b>',
    referral_disabled: "⚠️ This feature isn't active yet because the bot username hasn't been set. Ask the admin to set the bot username first so a referral link can be generated.",
    referral_body: 'Invite your friends to shop at <b>{store}</b> and get balance credited straight to your Wallet!\n\n{reward_emoji} <b>Reward per Referral:</b> {reward}\n\n{link_emoji} <b>Your Referral Link:</b>\n<code>{link}</code>\n\n<blockquote>{how_emoji} <b>How It Works:</b>\n1. Share your referral link\n2. Your friend opens the bot through that link\n3. Once your friend tops up their balance for the first time, your balance increases automatically!</blockquote>\n\n{total_emoji} <b>Total Referrals:</b> {count}\n{earnings_emoji} <b>Total Referral Earnings:</b> {earnings}',
    btn_share_referral: '📤 Share Referral Link',
    btn_copy_referral: '📋 Copy Referral Link',

    // ---- Gift (Buy Gift / Confess Gift, via userbot GramJS - see userbot.js) ----
    btn_gift_menu: '🎁 Buy Gift / Confess Gift',
    gift_not_configured: "⚠️ The Gift feature hasn't been configured by the admin yet (USERBOT_SESSION is empty).",
    gift_mode_title: "🎁 <b>Buy Gift / Confess Gift</b>\n\nFirst, choose how you want to send the gift:\n\n🎁 <b>Buy Gift</b> - the gift is sent on behalf of the store account, with NO message.\n💌 <b>Confess Gift</b> - gift + an anonymous message you write yourself, your identity is <b>hidden</b> from the recipient.",
    btn_gift_buy: '🎁 Buy Gift',
    btn_gift_confess: '💌 Confess Gift',
    gift_list_title_buy: '🎁 <b>Buy Gift</b>\n\nPick a gift below to send to any Telegram user (just their username or ID).',
    gift_list_title_confess: "💌 <b>Confess Gift</b>\n\nPick a gift below, then send it to anyone along with an anonymous message. Your identity is <b>hidden</b> from the recipient.",
    gift_not_found: '⚠️ Gift not found / already out of stock, please try again.',
    gift_detail_price_line: '💰 Price: {price}',
    gift_ask_target: "Send the recipient's Telegram username or ID (without @):",
    gift_invalid_target: '⚠️ Invalid username/ID, please resend it (example: <code>username</code> or <code>123456789</code>).',
    gift_ask_message: '💌 Type the anonymous message to send along with the gift (max 250 characters):',
    gift_confirm_title: '🧾 <b>{mode} Confirmation</b>',
    gift_confirm_gift_line: '🎁 Gift: {stars}⭐',
    gift_confirm_target_line: '🎯 Recipient: <code>{target}</code>',
    gift_confirm_message_line: '💌 Message: "{message}"',
    gift_confirm_hidden_notice: 'Your identity <b>will not be visible</b> to the recipient.',
    btn_gift_send_now: '✅ Send Now',

    products_title: '📦 <b>Available Products</b>\nPlease select a product to proceed:',
    variant_choose: 'Choose a variant:',
    product_not_found: 'Product not found.',
    btn_how_to_use: '❗️ How to Use',
    btn_buy_now: '✅ Buy Now',

    howto_not_available: "There's no usage guide for this product yet. Contact admin if you run into issues.",
    howto_page_title: '❗️ <b>How to Use - {product}</b>',

    qty_custom: '✏️ Custom Amount',
    order_confirm_title: '{title_icon} <b>Order Confirmation</b>',
    btn_place_order: '💰 Place Order',
    btn_cancel_order: '❌ Cancel Order',

    btn_cancel_arrow: '⬅️ Cancel',
    topup_qris_not_configured: '⚠️ QRIS payment has not been configured by the admin (`PAYKITA_API_KEY` is empty in `.env`).',
    topup_usdt_not_configured: '⚠️ USDT (BEP20) payment has not been configured by the admin (`USDT_BEP20_ADDRESS` is empty in `.env`).',
    topup_ton_not_configured: '⚠️ TON payment has not been configured by the admin (`TON_ADDRESS` is empty in `.env`).',
    topup_binance_not_configured: '⚠️ Binance Pay payment has not been configured by the admin (`BINANCE_API_KEY`/`BINANCE_PAY_ID` is empty in `.env`).',

    qris_choose_amount_title: '{emoji_qris_amount} <b>CHOOSE DEPOSIT AMOUNT</b>\n\nPlease pick an instant deposit amount below, or use a Custom Amount:',
    btn_custom_amount: '✏️ Custom Amount',
    qris_custom_prompt: '✏️ *Custom Amount*\n\nType the topup amount in USD (numbers only, decimals allowed, minimum {min}), example: `5` or `5.25`.',
    qris_creating: '{emoji_hourglass} Creating QRIS for <b>{amount}</b>...',
    toast_creating_qris: '⏳ Creating QRIS...',
    toast_creating_usdt_invoice: '⏳ Creating USDT invoice...',
    toast_creating_ton_invoice: '⏳ Creating TON invoice...',
    toast_creating_binance_invoice: '⏳ Creating Binance Pay invoice...',
    qris_invalid_amount: 'Invalid amount.',
    qris_too_small: '⚠️ Amount too small for QRIS (minimum {min}). Type a larger USD amount.',
    qris_create_failed: '⚠️ Failed to create the QRIS payment right now. Try again in a moment, or contact admin.',
    qris_invoice_caption: '{title_icon} <b>YOUR QRIS INVOICE IS READY!</b>\n━━━━━━━━━━━━━━━━━━\n\nJust one more step to a full balance! {rocket_icon}\n\n{orderid_icon} Order ID: <code>{orderId}</code>\n{saldo_icon} Balance you\'ll get: <b>{amount}</b>\n{total_icon} Total to pay via QRIS: <b>{total}</b>\n{expire_icon} Valid for: <b>10 minutes</b>\n\n{carabayar_icon} <b>How to pay:</b>\n{step1_icon} Open your favorite e-wallet / mobile banking app\n{step2_icon} Choose <b>Scan QR</b> / <b>QRIS</b>\n{step3_icon} Scan the QR above and pay the <b>exact</b> amount ({total}) — don\'t round it\n\n{auto_icon} Your Wallet balance is credited <b>AUTOMATICALLY</b> the instant payment is detected — no admin confirmation, no waiting!\n\n{tip_icon} Changed your mind? Just tap <b>Cancel Payment</b> below.',
    qris_qr_send_failed: '\n\n⚠️ Failed to display the QR image, contact admin with the Order ID above.',
    qris_expired: '⌛ QRIS topup `{id}` has expired (no payment received within 10 minutes). Please redo the topup if you still want to continue.',
    qris_paid: '✅ QRIS payment received!\nWallet balance increased by *{amount}*.\n💼 Current balance: *{balance}*',
    btn_qris_cancel: '❌ Cancel Payment',
    toast_payment_cancelled: 'Payment cancelled.',
    toast_topup_cancelled: 'Topup cancelled.',

    usdt_topup_prompt: '{emoji_usdt} <b>Topup via USDT (BEP20)</b>\n\nType the topup amount in USD (numbers only, decimals allowed, minimum {min}, maximum {max}), it will be processed as USDT 1:1. Example: <code>50</code> or <code>50.25</code>',
    usdt_invoice_text: '{title_icon} <b>Deposit via USDT (BEP20)</b>\n\n{min_icon} <b>Min Deposit:</b> {min}\n{max_icon} <b>Max Deposit:</b> {max}\n\nOrder ID: <code>{orderId}</code>\n\nSend <b>EXACTLY</b> this amount (don\'t round it):\n<code>{uniqueAmount}</code> USDT\n\n{address_icon} <b>Address</b> (<b>BEP20 / BNB Smart Chain</b> network ONLY):\n<code>{address}</code>\n\n⚠️ <b>Important:</b>\n• The amount must match EXACTLY down to 4 decimals so the system can auto-match it to your deposit.\n• You MUST use the BEP20 (BSC) network. Sending from another network risks losing funds.\n\n{auto_icon} <b>Automatic Deposit:</b> Your Wallet balance is credited automatically within 1-2 minutes after the transaction is confirmed on-chain. No need to send the Tx Hash manually.\n\n⏳ Valid for 30 minutes.',
    btn_copy_address: '📋 Copy Address',
    btn_usdt_cancel: '❌ Cancel Topup',
    usdt_expired: '⌛ USDT topup `{id}` has expired. Please redo the topup if you still want to continue.',
    usdt_paid: '✅ USDT payment received!\nTx Hash: `{hash}`\nWallet balance increased by *{amount}*.\n💼 Current balance: *{balance}*',

    ton_topup_prompt: '{emoji_ton} <b>Topup via TON (The Open Network)</b>\n\nType the topup amount in USD (numbers only, decimals allowed, minimum {min}, maximum {max}), it will be auto-converted to TON using the live rate. Example: <code>5</code> or <code>5.25</code>',
    ton_invoice_text: '{title_icon} <b>Deposit via TON (The Open Network)</b>\n\n{min_icon} <b>Min Deposit:</b> {min}\n{max_icon} <b>Max Deposit:</b> {max}\n\nOrder ID: <code>{orderId}</code>\n\nSend <b>EXACTLY</b> this amount (don\'t round it):\n<code>{uniqueAmount}</code> TON\n\n{address_icon} <b>Address</b> (native <b>TON</b> network ONLY):\n<code>{address}</code>\n\n⚠️ <b>Important:</b>\n• The amount must match EXACTLY down to 4 decimals so the system can auto-match it to your deposit.\n• Send directly from a TON wallet (Tonkeeper, Tonhub, etc), NOT from an exchange that trims/rounds the sent amount.\n\n{auto_icon} <b>Automatic Deposit:</b> Your Wallet balance is credited automatically within 1-2 minutes after the transaction is confirmed on-chain. No need to send the Tx Hash manually.\n\n⏳ Valid for 30 minutes.',
    btn_ton_cancel: '❌ Cancel Topup',
    ton_expired: '⌛ TON topup `{id}` has expired. Please redo the topup if you still want to continue.',
    ton_paid: '✅ TON payment received!\nWallet balance increased by *{amount}*.\n💼 Current balance: *{balance}*',

    btn_topup_binance: 'Binance Pay (Automatic)',
    binance_topup_prompt: '{emoji_binance} <b>Topup via Binance Pay</b>\n\nType the topup amount in USD (numbers only, decimals allowed, minimum {min}, maximum {max}), it will be processed 1:1. Example: <code>10</code> or <code>10.5</code>',
    binance_invoice_text: '{title_icon} <b>Deposit via Binance Pay</b>\n\n{min_icon} <b>Min Deposit:</b> {min}\n{max_icon} <b>Max Deposit:</b> {max}\n\nOrder ID: <code>{orderId}</code>\n\nSend <b>EXACTLY</b> this amount in <b>USDT</b> via the <b>Pay</b> menu in the Binance app (don\'t round it, and don\'t use another asset):\n<code>{uniqueAmount}</code>\n\n{payid_icon} <b>Binance ID</b> (tap to copy):\n<code>{payId}</code>\n\n⚠️ <b>Important:</b>\n• The amount must match EXACTLY down to 4 decimals, and the asset MUST be USDT - sending another asset (BNB, BUSD, etc.) will NOT be detected automatically even if the number matches exactly.\n• Send via <b>Pay -&gt; Send</b> to the Binance ID above, NOT a regular P2P/transfer.\n\n{auto_icon} <b>Automatic Deposit:</b> Your Wallet balance is credited automatically within 1-2 minutes after the transaction is detected in the Binance Pay history. No need to send a proof/Order ID to admin manually.\n\n⏳ Valid for 30 minutes.',
    btn_copy_binance_id: '📋 Copy Binance ID',
    btn_binance_cancel: '❌ Cancel Topup',
    binance_expired: '⌛ Binance Pay topup `{id}` has expired. Please redo the topup if you still want to continue.',
    binance_paid: '✅ Binance Pay payment received!\nRef: `{id}`\nWallet balance increased by *{amount}*.\n💼 Current balance: *{balance}*',

    pending_min_amount: '⚠️ Minimum amount is {min}. Retype the USD amount (numbers only, decimals allowed).',
    pending_min_amount_generic: '⚠️ Minimum amount is {min}. Retype the amount (numbers only, decimals allowed).',
    pending_max_amount: '⚠️ Maximum amount is {max}. Retype the amount (numbers only, decimals allowed).',

    order_not_found: 'Order not found.',
    variant_not_found: 'Variant not found.',
    product_variant_not_found: 'Product/variant not found.',
    recover_item_not_recoverable: "This order's item can't be recovered.",
    totp_refreshed: '🔄 2FA code refreshed.',
    btn_refresh_2fa: '🔄 Refresh 2FA Code',
    out_of_stock: '❌ Out of stock, please pick another product.',
    ask_custom_qty: '✏️ Type the quantity you want to buy (numbers only):',
    invalid_qty: '⚠️ Invalid quantity.',
    invalid_qty_number: '⚠️ Enter a valid quantity (numbers only).',
    not_enough_stock: 'Not enough stock. Remaining stock: {stock}',
    supplier_order_failed: "⚠️ Stock is temporarily unavailable from the supplier, please try again shortly. Your balance hasn't been charged.",
    supplier_balance_empty: "⚠️ Supplier balance is currently empty, our team is topping it up. Please try again shortly. Your balance hasn't been charged.",
    insufficient_balance: 'Your balance is not enough. Please topup first.',
    insufficient_balance_shortfall_label: 'Short by',
    insufficient_balance_cta: 'Top up instantly via one of the methods below:',
    generic_error: 'An error occurred.',
    recover_order_not_found: "⚠️ Order ID `{orderId}` wasn't found on your account. Double-check the ID via the My Orders menu.",
    recover_no_items: "⚠️ Order `{orderId}` doesn't have any recoverable items yet (not auto-delivered). Contact admin for help.",
    referral_username_missing: '⚠️ BOT_USERNAME has not been set by the admin in .env.',

    enter_qty_title: '<blockquote>{emoji_warning} <b>Enter Quantity</b>\nHow many pcs of {product} do you want to buy?</blockquote>\n\n{tiers}\n\n{emoji_stock} Available stock: <b>{stock}</b>',
    price_per_pcs: 'Price: <b>{price}</b> / pcs',
    bulk_discount_title: '{emoji_title} <b>Bulk Discount</b>',
    bulk_discount_line: '{emoji_check} Buy {range} → <b>{price}</b> / pcs',
    desc_fallback: 'Price from {price} / pcs.\nAvailable stock: {stock}',
    live_totp_note: '<i>(live, valid for ~{seconds}s more)</i>',
    account_label: 'Account',

    order_confirm_body: 'Product: {product}\nQuantity: {qty}\nTotal Bill: <b>{total}</b>\n\n{balance_icon} Wallet Balance: <b>{balance}</b>\n{stock_icon} Available Stock: <b>{stock}</b>',

    success_title: '🎉 <b>ORDER SUCCESSFUL!</b> 🎉',
    success_product_label: '<b>Product:</b>',
    success_qty_label: '<b>Quantity:</b>',
    success_qty_unit: '{qty} pcs',
    success_total_label: '<b>Total Paid:</b>',
    success_orderid_label: '<b>Order ID:</b>',
    success_delivered_title: '🚀 <b>Your product has been auto-delivered, check it out below!</b>',
    success_delivered_detail: '🔗 <b>Product / Redeem Details:</b>',
    success_manual: "📦 Admin will process this shortly and send the account/details to this chat manually.",
    success_thanks: '🙏 <b>Thanks for shopping at {store}!</b> See you on your next order',

    forcejoin_title: '{lock_icon} <b>ONE LAST STEP!</b> {lock_icon}',
    forcejoin_desc: '{sparkle_icon} The gates to <b>{store}</b> only open once you join our official channel(s)/group(s) below. It\'s free and takes just a few seconds! {bolt_icon}\n\n{arrow_icon} Tap the button(s), join, then come back and hit <b>"{check_icon} I\'ve Joined"</b> to verify automatically.',
    forcejoin_channel_line: '{status} {title}',
    forcejoin_status_joined: '✅',
    forcejoin_status_pending: '🔸',
    btn_checkjoin: '✅ I\'ve Joined',
    forcejoin_still_locked: '🚫 Looks like you haven\'t joined all the channels/groups yet. Join them all first, then tap this button again!',
    forcejoin_all_joined_toast: '🎉 Awesome, you\'ve joined everything! Welcome aboard~',
    btn_join_channel: '📢 Join {title}',

    maintenance_title: '{wrench_icon} <b>UNDER MAINTENANCE</b> {wrench_icon}',
    maintenance_desc: '{sparkle_icon} Hey <b>{store}</b> fam! We\'re upgrading & polishing the bot to make it faster, more stable, and even more premium for you. {bolt_icon}\n\n{clock_icon} Please hang tight, we\'ll be back shortly!\n{heart_icon} Thanks so much for your patience 🙏',

    maintenance_finished_title: '{rocket_icon} <b>WE\'RE BACK ONLINE!</b> {rocket_icon}',
    maintenance_finished_desc: '{sparkle_icon} Great news, <b>{store}</b> fam! Maintenance is {check_icon} <b>DONE</b> — the bot is now faster, more stable, and even more premium than before. {bolt_icon}\n\n{gift_icon} Every feature is back to normal — go ahead and place your order now!\n{heart_icon} Thanks so much for your patience 🙏'
  }
};

function interpolate(str, vars) {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m));
}

// Ambil teks dengan kode bahasa spesifik (tidak tergantung user manapun)
function tr(langCode, key, vars) {
  const lang = DICT[langCode] ? langCode : 'id';
  const str = DICT[lang][key];
  if (str === undefined) return key;
  return interpolate(str, vars);
}

function getUserLang(chatId) {
  return db.getUserLang(chatId);
}

function setUserLang(chatId, langCode) {
  return db.setUserLang(chatId, langCode);
}

// Ambil teks berdasarkan bahasa user (fallback 'id' kalau belum pernah pilih)
function t(chatId, key, vars) {
  return tr(getUserLang(chatId), key, vars);
}

function languageKeyboard(backCallback) {
  const rows = [
    [{ text: LANGS.id.label, callback_data: 'lang:id' }],
    [{ text: LANGS.en.label, callback_data: 'lang:en' }]
  ];
  if (backCallback) {
    rows.push([{ text: '‹ Back / Kembali', callback_data: backCallback }]);
  }
  return { inline_keyboard: rows };
}

module.exports = { LANGS, t, tr, getUserLang, setUserLang, languageKeyboard };
