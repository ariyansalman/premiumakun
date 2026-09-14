// ===== userbot.js =====
// Userbot GramJS (MTProto, login pakai akun Telegram PRIBADI - bukan bot) -
// dipakai KHUSUS untuk fitur "🎁 Buy Gift" & "💌 Confess Gift" di bot.js,
// supaya bisa kirim Telegram Star Gift ke user MANAPUN (termasuk yang belum
// pernah /start bot ini), karena Bot API resmi (sendGift) mensyaratkan bot
// punya saldo Stars sendiri dan attribusi pengirim tetap "dari bot" - kalau
// mau kirim dari akun yang terlihat seperti akun pribadi biasa, itu HANYA
// bisa lewat MTProto (akun user asli), bukan Bot API.
//
// ⚠️ CATATAN PENTING (wajib dibaca sebelum dipakai produksi):
// 1. Akun yang dipakai login di sini akan melakukan aksi OTOMATIS (kirim
//    gift+pesan) berulang kali. Telegram menerapkan FloodWait di level
//    server untuk aksi beruntun ke banyak peer berbeda dalam waktu singkat -
//    ini TIDAK BISA dihilangkan dari kode manapun, cuma bisa di-retry pelan.
// 2. Simpan SESSION_STRING hasil login (lihat userbot-login.js) sebagai
//    rahasia setara password akun itu sendiri - siapapun yang pegang string
//    itu bisa login penuh sebagai akun tsb tanpa perlu OTP lagi.
// 3. Field-field RPC di bawah (GetStarGifts / GetPaymentForm / SendStarsForm
//    / InputInvoiceStarGift) mengikuti skema resmi core.telegram.org per
//    layer 196+. Kalau versi GramJS yang ke-install beda skema (nama field
//    berubah), lihat komentar "SESUAIKAN DI SINI" di masing-masing fungsi.

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const API_ID = Number(process.env.USERBOT_API_ID || 0);
const API_HASH = process.env.USERBOT_API_HASH || '';
const SESSION_STRING = process.env.USERBOT_SESSION || '';

let client = null;
let connecting = null;

// Cache katalog gift (starGift[]) supaya tidak query ulang tiap kali menu
// dibuka - di-refresh tiap GIFT_CATALOG_TTL_MS.
let giftCatalogCache = null;
let giftCatalogCachedAt = 0;
const GIFT_CATALOG_TTL_MS = 5 * 60 * 1000; // 5 menit

function isConfigured() {
  return !!(API_ID && API_HASH && SESSION_STRING);
}

// Pastikan client GramJS sudah connect - dipanggil otomatis di setiap fungsi
// publik di bawah, jadi pemanggil (bot.js) tidak perlu urus koneksi manual.
async function ensureConnected() {
  if (!isConfigured()) {
    throw new Error(
      'Userbot belum dikonfigurasi. Isi USERBOT_API_ID, USERBOT_API_HASH, ' +
      'USERBOT_SESSION di .env (lihat userbot-login.js untuk cara dapat session).'
    );
  }
  if (client && client.connected) return client;
  if (connecting) return connecting;

  connecting = (async () => {
    const c = new TelegramClient(new StringSession(SESSION_STRING), API_ID, API_HASH, {
      connectionRetries: 5
    });
    await c.connect();
    const me = await c.getMe();
    console.log(`✅ Userbot GramJS connected sebagai @${me.username || me.id}`);
    client = c;
    return c;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

// Ambil daftar gift Telegram Stars resmi yang bisa dikirim (id, harga stars,
// batas per-user kalau limited, dll). Dipakai buat render menu inline "🎁
// Buy Gift" - setiap item disimpan dengan emoji + custom_emoji_id (kalau
// gift itu punya sticker premium) supaya bot.js bisa render pakai
// <tg-emoji emoji-id="..."> sama seperti produk biasa (lihat
// productEmojiHtml() di bot.js).
// Sticker gift dari Telegram (g.sticker) adalah object Document biasa - TIDAK
// ada field "customEmojiId" langsung di situ (itu bug versi lama, makanya
// emojiId selalu null & semua tombol gift jatuh ke 1 ikon fallback yang sama,
// gak peduli gift-nya beda-beda -> makanya ikon tombol "tidak sesuai" sama
// gift aslinya). ID custom emoji yang VALID untuk dipakai di field
// icon_custom_emoji_id itu SAMA DENGAN id dokumennya sendiri (g.sticker.id),
// TAPI cuma valid dipakai sebagai custom emoji kalau dokumen itu memang
// terdaftar sebagai custom emoji (attribute DocumentAttributeCustomEmoji ada
// di g.sticker.attributes). Kalau sticker gift itu cuma sticker biasa (tanpa
// attribute itu - ini yang paling sering terjadi untuk gift unik/limited),
// balikin null supaya pemanggilnya fallback dengan aman (lihat giftIconId()
// di bot.js, yang juga kasih admin opsi override ID manual per-gift lewat
// "🎁 Kelola Emoji Gift").
function giftStickerEmojiId(sticker) {
  if (!sticker || !sticker.id || !Array.isArray(sticker.attributes)) return null;
  const isCustomEmoji = sticker.attributes.some(a => a.className === 'DocumentAttributeCustomEmoji');
  return isCustomEmoji ? sticker.id.toString() : null;
}

async function getGiftCatalog(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && giftCatalogCache && now - giftCatalogCachedAt < GIFT_CATALOG_TTL_MS) {
    return giftCatalogCache;
  }
  const c = await ensureConnected();

  // SESUAIKAN DI SINI kalau GramJS versi kamu memberi nama beda untuk method
  // ini (skema resminya: payments.getStarGifts, lihat
  // https://core.telegram.org/method/payments.getStarGifts).
  const result = await c.invoke(new Api.payments.GetStarGifts({ hash: 0 }));
  const gifts = (result.gifts || []).filter(g => !g.soldOut);

  const catalog = gifts.map(g => ({
    id: g.id.toString(),
    stars: Number(g.stars),
    limited: !!g.limited,
    availabilityRemains: g.availabilityRemains || null,
    // Emoji unicode fallback + custom_emoji_id asli dari sticker gift-nya
    // (kalau memang terdaftar sebagai custom emoji - lihat giftStickerEmojiId
    // di atas). Kalau tidak tersedia, tetap null - bot.js/giftIconId() yang
    // urus fallback berikutnya (override manual admin, baru ikon global).
    emoji: '🎁',
    emojiId: giftStickerEmojiId(g.sticker)
  }));

  giftCatalogCache = catalog;
  giftCatalogCachedAt = now;
  return catalog;
}

// Resolve target (username TANPA @, atau numeric user id) jadi ENTITY penuh
// (Api.User) - dipakai buat checkTargetExists() yang butuh detail (username/
// firstName/lastName/isBot). Melempar error kalau user tidak ditemukan /
// privacy settings memblokir - bot.js WAJIB tangkap error ini dan refund
// otomatis saldo wallet buyer (lihat db.updateBalance di bot.js).
async function resolveTargetPeer(client, targetUsernameOrId) {
  const raw = String(targetUsernameOrId).trim().replace(/^@/, '');
  try {
    const entity = await client.getEntity(raw);
    return entity;
  } catch (err) {
    const notFound = new Error(`Target "${raw}" tidak ditemukan di Telegram.`);
    notFound.code = 'TARGET_NOT_FOUND';
    throw notFound;
  }
}

// ⚠️ FIX BUG "400: PEER_ID_INVALID (caused by payments.GetPaymentForm)":
// resolveTargetPeer() di atas mengembalikan Api.User APA ADANYA (entity
// "penuh"), BUKAN Api.InputPeer. Field `peer` di InputInvoiceStarGift wajib
// diisi Api.InputPeer (mis. InputPeerUser{userId, accessHash}) - kalau
// diisi Api.User mentah, GramJS TIDAK otomatis mengonversinya untuk
// pemanggilan c.invoke() manual seperti sendGiftToUser() di bawah (beda
// dengan method tingkat tinggi semacam client.sendMessage() yang memang
// auto-convert). Hasilnya Telegram server menolak dengan PEER_ID_INVALID.
// Fungsi ini pakai client.getInputEntity() bawaan GramJS yang memang
// tugasnya khusus resolve ke bentuk InputPeer/InputUser yang valid.
async function resolveInputPeer(client, targetUsernameOrId) {
  const raw = String(targetUsernameOrId).trim().replace(/^@/, '');
  try {
    return await client.getInputEntity(raw);
  } catch (err) {
    const notFound = new Error(`Target "${raw}" tidak ditemukan di Telegram.`);
    notFound.code = 'TARGET_NOT_FOUND';
    throw notFound;
  }
}

// Cek apakah username/ID Telegram valid & beneran ADA (dipakai buat validasi
// real-time SEBELUM buyer lanjut ke halaman konfirmasi - lihat
// verifyTelegramTarget() di bot.js, dipakai fitur Buy Gift/Confess Gift).
// Tujuannya: kalau target salah ketik/
// tidak eksis, ketahuan dari awal (saldo belum kepotong sama sekali),
// bukan baru gagal pas eksekusi kirim (yang walau sudah ada refund
// otomatis, tetap bikin buyer nunggu proses sia-sia).
//
// Return: { id, username, firstName, lastName, isBot } kalau target ketemu.
// Throw Error dengan code 'TARGET_NOT_FOUND' kalau tidak ketemu/invalid -
// bot.js WAJIB catch ini dan kasih tau user buat cek ulang ketikannya.
//
// CATATAN GramJS: khusus input angka (numeric user ID, bukan username),
// Telegram/GramJS kadang menolak resolve kalau userbot belum pernah
// "ketemu" ID itu sama sekali (belum ada access_hash tersimpan di sesi
// userbot - keterbatasan API Telegram, bukan bug). Username biasa (huruf)
// tidak kena batasan ini karena resolve-nya lewat username langsung.
async function checkTargetExists(targetUsernameOrId) {
  const c = await ensureConnected();
  const peer = await resolveTargetPeer(c, targetUsernameOrId);
  return {
    id: peer.id ? peer.id.toString() : null,
    username: peer.username || null,
    firstName: peer.firstName || null,
    lastName: peer.lastName || null,
    isBot: !!peer.bot
  };
}

// Kirim SATU Telegram Star Gift ke target, dengan pesan opsional (dipakai
// untuk fitur "💌 Confess Gift" - pesan anonim yang nempel di gift).
//
// Params:
//   targetUsernameOrId : string  - username (tanpa @) atau numeric user id
//   giftId              : string  - id gift dari getGiftCatalog()
//   message             : string  - pesan yang nempel di gift (opsional,
//                                    dibatasi Telegram ~255 karakter)
//   hideName            : boolean - true = identitas pengirim (akun
//                                    userbot) disembunyikan dari penerima
//                                    kalau mereka pajang gift itu di profil
//                                    (sesuai flag hide_name di
//                                    inputInvoiceStarGift resmi Telegram)
//
// Return: { success: true } kalau berhasil.
// Melempar Error kalau gagal (bot.js WAJIB catch + refund otomatis).
async function sendGiftToUser({ targetUsernameOrId, giftId, message, hideName = true }) {
  const c = await ensureConnected();
  const peer = await resolveInputPeer(c, targetUsernameOrId);

  // SESUAIKAN DI SINI kalau nama constructor GramJS beda dari skema resmi:
  // - Api.InputInvoiceStarGift (skema: core.telegram.org/constructor/inputInvoiceStarGift)
  // - Api.payments.GetPaymentForm
  // - Api.payments.SendStarsForm
  const invoice = new Api.InputInvoiceStarGift({
    hideName: !!hideName,
    peer,
    giftId: BigInt(giftId),
    message: message
      ? new Api.TextWithEntities({ text: message, entities: [] })
      : undefined
  });

  const form = await c.invoke(new Api.payments.GetPaymentForm({ invoice }));

  // Pembayaran Stars langsung dieksekusi dari saldo Stars akun userbot
  // (tidak perlu konfirmasi form eksternal seperti kartu kredit/QRIS),
  // makanya cukup panggil SendStarsForm dengan formId dari response di atas.
  const result = await c.invoke(
    new Api.payments.SendStarsForm({
      formId: form.formId,
      invoice
    })
  );

  return { success: true, raw: result };
}

// Cache saldo Stars userbot supaya cek pra-kirim (lihat bot.js gift:confirm)
// tidak nembak API tiap kali ada buyer konfirmasi order beruntun.
let starsBalanceCache = null;
let starsBalanceCachedAt = 0;
const STARS_BALANCE_TTL_MS = 20 * 1000; // 20 detik

async function getUserbotStarsBalance(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && starsBalanceCache !== null && now - starsBalanceCachedAt < STARS_BALANCE_TTL_MS) {
    return starsBalanceCache;
  }
  const c = await ensureConnected();
  const status = await c.invoke(new Api.payments.GetStarsStatus({ peer: new Api.InputPeerSelf() }));
  const balance = Number(status.balance.amount || status.balance || 0);
  starsBalanceCache = balance;
  starsBalanceCachedAt = now;
  return balance;
}

module.exports = {
  isConfigured,
  ensureConnected,
  getGiftCatalog,
  sendGiftToUser,
  getUserbotStarsBalance,
  checkTargetExists
};
