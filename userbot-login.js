// ===== userbot-login.js =====
// Jalankan SEKALI SAJA secara manual (bukan lewat bot.js) untuk login akun
// Telegram yang mau dipakai sebagai userbot pengirim gift:
//
//   node userbot-login.js
//
// Akan diminta: nomor HP, kode OTP dari Telegram, dan password 2FA (kalau
// akun itu punya). Di akhir, script mencetak SESSION_STRING - copy nilai itu
// ke .env sebagai USERBOT_SESSION. Setelah tersimpan, userbot.js otomatis
// pakai session ini setiap kali bot jalan, TANPA perlu login ulang.
//
// Dapatkan USERBOT_API_ID & USERBOT_API_HASH dari https://my.telegram.org
// -> API Development Tools -> buat aplikasi baru (nama bebas).
//
// ⚠️ Sebaiknya PAKAI AKUN TELEGRAM TERPISAH (bukan akun pribadi utama kamu)
// khusus untuk userbot ini, supaya kalau kena limit/flag dari Telegram
// karena aktivitas otomatis, tidak mengganggu akun pribadimu.

require('dotenv').config();
const input = require('input'); // sudah ikut ter-install sebagai dependency 'telegram'
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const API_ID = Number(process.env.USERBOT_API_ID || 0);
const API_HASH = process.env.USERBOT_API_HASH || '';

(async () => {
  if (!API_ID || !API_HASH) {
    console.error('❌ Isi dulu USERBOT_API_ID dan USERBOT_API_HASH di .env (dari https://my.telegram.org).');
    process.exit(1);
  }

  console.log('🔐 Login userbot GramJS...\n');
  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, { connectionRetries: 5 });

  await client.start({
    phoneNumber: async () => await input.text('Nomor HP (format +62...): '),
    password: async () => await input.text('Password 2FA (kosongkan kalau tidak ada, Enter): '),
    phoneCode: async () => await input.text('Kode OTP dari Telegram: '),
    onError: (err) => console.error(err)
  });

  console.log('\n✅ Login berhasil!\n');
  console.log('Tempel baris berikut ke file .env kamu:\n');
  console.log(`USERBOT_SESSION=${client.session.save()}\n`);

  await client.disconnect();
  process.exit(0);
})();
