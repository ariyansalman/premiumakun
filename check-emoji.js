// ============================================================
// CEK VALIDITAS CUSTOM EMOJI ID (jalankan manual, bukan bagian bot.js)
// ============================================================
// Tujuan: mastiin ID-ID di data/db.json (per produk), emoji-id-teks.js,
// dan emoji-id-menu-inline.js itu BENERAN ada / valid di Telegram - lewat
// method resmi Bot API "getCustomEmojiStickers". Method ini TIDAK butuh
// akun Premium buat dipanggil, dan TIDAK peduli siapa pemilik emoji-nya -
// dia cuma jawab "ID ini exist atau nggak" + kasih tau bentuk emoji aslinya
// (lewat field `emoji` unicode-nya paling deket & is_video/is_animated).
// Jadi ini murni ngecek ID VALID/TIDAK, BUKAN ngecek apakah owner bot lagi
// Premium aktif atau nggak (itu beda hal, cuma kelihatan pas bot beneran
// kirim pesan ke chat asli).
//
// Cara pakai:
//   1. Pastikan .env sudah ada BOT_TOKEN (tidak perlu bot lagi jalan/polling).
//   2. Jalankan: node check-emoji.js
//   3. Baca hasilnya: ✅ VALID (ID exist, ketahuan wujud emoji aslinya)
//                     ❌ TIDAK ADA / SALAH (ID tidak ketemu sama sekali di Telegram)
// ============================================================

require('dotenv').config();
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN belum diset di .env');
  process.exit(1);
}

const db = require('./db');
const { EMOJI_ID_TEKS_BACKUP } = require('./emoji-id-teks');
const { EMOJI_IDS } = require('./emoji-id-menu-inline');

// Kumpulkan SEMUA id dari 4 sumber, dengan label asalnya masing-masing biar
// gampang ditelusuri kalau ternyata ada yang tidak valid.
function collectAllIds() {
  const labeled = []; // { id, label }

  // 1) Per-produk (data/db.json -> products[].emojiId)
  const dbData = db.getRawDb ? db.getRawDb() : JSON.parse(require('fs').readFileSync('./data/db.json', 'utf8'));
  (dbData.products || []).forEach(p => {
    if (p.emojiId) labeled.push({ id: String(p.emojiId), label: `produk:${p.name}` });
  });

  // 2) Hasil capture admin tersimpan di db.json -> emojiIds (key "teks:*"/"menu:*")
  Object.entries(dbData.emojiIds || {}).forEach(([key, id]) => {
    if (id) labeled.push({ id: String(id), label: `db.json emojiIds:${key}` });
  });

  // 3) Backup statis teks (emoji-id-teks.js)
  Object.entries(EMOJI_ID_TEKS_BACKUP || {}).forEach(([key, id]) => {
    if (id) labeled.push({ id: String(id), label: `emoji-id-teks.js:${key}` });
  });

  // 4) ID tombol menu inline (emoji-id-menu-inline.js)
  Object.entries(EMOJI_IDS || {}).forEach(([key, id]) => {
    if (id) labeled.push({ id: String(id), label: `emoji-id-menu-inline.js:${key}` });
  });

  return labeled;
}

async function main() {
  const labeled = collectAllIds();
  const uniqueIds = [...new Set(labeled.map(l => l.id))];
  console.log(`🔎 Mengecek ${uniqueIds.length} custom emoji ID unik ke Telegram...\n`);

  // Bot API batasi max 200 id per panggilan getCustomEmojiStickers - aman
  // di-chunk 100 per batch.
  const found = new Map(); // id -> sticker info
  for (let i = 0; i < uniqueIds.length; i += 100) {
    const chunk = uniqueIds.slice(i, i + 100);
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getCustomEmojiStickers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ custom_emoji_ids: chunk })
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('❌ Panggilan API gagal:', data.description);
      process.exit(1);
    }
    data.result.forEach(sticker => found.set(sticker.custom_emoji_id, sticker));
  }

  const invalidIds = uniqueIds.filter(id => !found.has(id));

  console.log(`✅ VALID: ${found.size}/${uniqueIds.length}\n`);
  found.forEach((sticker, id) => {
    const labels = labeled.filter(l => l.id === id).map(l => l.label).join(', ');
    console.log(`  ✅ ${id}  (wujud asli mirip: ${sticker.emoji}${sticker.is_video ? ', video' : sticker.is_animated ? ', animated' : ''})\n     dipakai di: ${labels}`);
  });

  if (invalidIds.length) {
    console.log(`\n❌ TIDAK VALID / TIDAK KETEMU: ${invalidIds.length}\n`);
    invalidIds.forEach(id => {
      const labels = labeled.filter(l => l.id === id).map(l => l.label).join(', ');
      console.log(`  ❌ ${id}\n     dipakai di: ${labels}`);
    });
    console.log('\n⚠️ ID di atas TIDAK akan pernah tampil premium (fallback ke unicode biasa terus),\nkarena ID-nya sendiri memang tidak ada di Telegram. Perlu ditangkap ulang lewat\n"🎨 Kelola Emoji ID" (forward emoji premium asli), atau isi manual dengan ID yang benar.');
  } else {
    console.log('\n🎉 Semua ID valid! Kalau di chat masih ada yang tampil bukan-premium,\nkemungkinan besar itu murni karena akun OWNER BOT belum punya Telegram Premium\naktif (syarat wajib Bot API 9.4), bukan karena ID-nya salah.');
  }
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
