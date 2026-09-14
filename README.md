# Premium Akun Bot (Telegram)

Bot Telegram dengan menu inline untuk jual akun premium (Gemini Premium 18 Bulan, Netflix, Spotify, dll) dengan **Wallet topup otomatis** lewat QRIS (PayKita) dan USDT jaringan BEP20 — saldo masuk otomatis begitu pembayaran terdeteksi, tanpa perlu approve admin.

## Fitur

- Menu inline: Produk → Kategori → Varian → Konfirmasi beli
- Saldo Wallet user, potong otomatis saat beli
- **Topup Wallet otomatis** — 3 metode:
  - **QRIS** lewat [PayKita](https://pay.digikita.id): QR dinamis dibuat per transaksi, saldo masuk otomatis begitu status order berubah jadi PAID
  - **USDT (BEP20 / BNB Smart Chain)**: bot generate nominal USDT unik per transaksi, memantau mutasi masuk on-chain langsung dari RPC node BSC, saldo masuk otomatis begitu transaksi terkonfirmasi
  - **TON (The Open Network)**: sama konsepnya dengan USDT, dipantau lewat TonCenter API
  - **Binance Pay**: transfer C2C ke Binance ID pribadi toko, bot generate nominal unik per transaksi dan memantau histori pembayaran lewat API resmi Binance (`GET /sapi/v1/pay/transactions`, cukup API key biasa/bukan Merchant), saldo masuk otomatis begitu transaksi terdeteksi
- Notifikasi order baru ke semua admin
- Admin panel via command: tambah/hapus produk & varian, koreksi saldo user manual, cek order
- **Auto Backup** — zip full source code project (kecuali `node_modules` & `.npm`), dikirim otomatis ke group Telegram tiap interval menit/jam yang diatur admin
- **Tier Diskon Grosir 3-tingkat** (1-49 / 50-499 / 500+ pcs) per varian — harga jual bisa diketik manual langsung (🎁 Set Tier Diskon Grosir) atau dihitung otomatis dari markup% atas modal Supplier (📊 Atur Markup 3-Tier), dengan opsi **🔒 Kunci Harga Manual** khusus varian Supplier API supaya tidak ketimpa auto-sync
- Database file JSON lokal (`data/db.json`) — tidak perlu setup database server

## Instalasi

1. Pastikan Node.js sudah terinstall (**v18+ wajib** — dipakai untuk `fetch` bawaan saat memanggil API PayKita/BscScan).
2. Install dependency:
   ```bash
   npm install
   ```
3. Salin `.env.example` jadi `.env`, lalu isi:
   ```
   BOT_TOKEN=token_dari_botfather
   ADMIN_IDS=123456789,987654321
   STORE_NAME=Nama Toko Kamu
   BOT_USERNAME=UsernameBotKamu
   REFERRAL_REWARD=2000
   ```
   - Dapatkan `BOT_TOKEN` dari [@BotFather](https://t.me/BotFather).
   - Dapatkan ID Telegram kamu dari [@userinfobot](https://t.me/userinfobot).
   - `BOT_USERNAME` diisi username bot **tanpa** `@` (contoh: `PremiumStoreBot`) — dipakai untuk membuat link referral pribadi tiap user. Kalau kosong, menu Referral akan menampilkan peringatan.
   - `REFERRAL_REWARD` adalah nominal saldo (USD) yang didapat pengundang setiap kali temannya membuka bot lewat link referral untuk pertama kali. Default: 1.
4. Isi juga konfigurasi **Wallet Topup Otomatis** (lihat bagian di bawah).
5. Jalankan bot:
   ```bash
   npm start
   ```

## 💳 Wallet Topup Otomatis

Ada 2 metode pembayaran yang bisa diaktifkan independen satu sama lain — kalau salah satu belum diisi konfigurasinya, bot akan kasih pesan peringatan ke user saat metode itu dipilih (bukan error/crash).

### 1) QRIS via PayKita

PayKita adalah *payment tool* yang menghubungkan QRIS statis milik kamu sendiri (ShopeePay Partner / GoPay Merchant / provider lain via Listener) menjadi QRIS dinamis per transaksi dengan deteksi pembayaran otomatis.

**Cara setup:**
1. Daftar & login di [pay.digikita.id/register](https://pay.digikita.id/register)
2. Hubungkan salah satu provider QRIS kamu dari dashboard (baca dulu halaman risiko integrasi yang ditautkan di sana)
3. Test alur pembayaran dari dashboard dulu sampai order berubah status **PAID** — ini bisa dicoba gratis tanpa langganan
4. Setelah yakin, aktifkan langganan API (mulai Rp5.000/1 bulan) untuk membuka **REST API**
5. Buat API key (`pk_live_...`) dari dashboard, lalu isi ke `.env`:
   ```
   PAYKITA_API_KEY=pk_live_xxxxxxxxxxxx
   PAYKITA_API_BASE=https://paykita.biz.id
   ```

**⚠️ Catatan integrasi (penting dibaca):**
Halaman dokumentasi resmi PayKita (`https://pay.digikita.id/documentation`) mengharuskan login ke dashboard merchant untuk dibuka, jadi nama field response API secara PERSIS (nama field QR, endpoint cek status by id, dst) tidak bisa diverifikasi tanpa akses login tersebut. Kode integrasi (`payment.js`) sudah ditulis defensif — mencoba beberapa kemungkinan nama field & endpoint sekaligus berdasarkan info yang tersedia publik di halaman utama PayKita:
- Endpoint create order: `POST https://paykita.biz.id/api/orders` dengan header `x-api-key` dan body `{ base_amount, reference }`
- Order otomatis berubah status jadi `PAID` begitu mutasi pembayaran cocok

Kalau setelah kamu pasang API key ternyata QR tidak muncul atau status pembayaran tidak terdeteksi otomatis, buka `payment.js`, cari komentar di bagian atas file (ada instruksi persis 3 hal yang perlu dicek & disesuaikan setelah kamu login ke dashboard PayKita dan lihat response API asli). Tidak ada bagian lain di `bot.js` yang perlu diubah setelah itu.

### 2) USDT jaringan BEP20 (BNB Smart Chain)

Metode ini memantau mutasi masuk **langsung dari blockchain** (bukan API pihak ketiga berbayar) lewat [BscScan API](https://bscscan.com/apis), jadi gratis dan tidak butuh HP/aplikasi yang harus nyala terus.

**Cara setup:**
1. Siapkan alamat wallet BEP20 (BSC) milik kamu sendiri untuk menerima USDT
2. Daftar & buat API key gratis di [bscscan.com/myapikey](https://bscscan.com/myapikey)
3. Isi ke `.env`:
   ```
   USDT_BEP20_ADDRESS=0xAlamatWalletKamu
   BSCSCAN_API_KEY=apikey_dari_bscscan
   ```
   Toko ini sudah pakai USD sebagai mata uang utama, dan USDT dipatok ~1:1 ke USD, jadi nominal topup dalam USD langsung dipakai sebagai dasar nominal USDT — tidak perlu kurs konversi lagi.

**Cara kerja pencocokan otomatis:** karena transfer USDT di blockchain tidak punya kolom memo/catatan, bot menambahkan variasi kecil 4 desimal (mis. `50` USD → `50.0672` USDT, bukan `50.0000` USDT rata) ke setiap permintaan topup supaya nominalnya unik. Bot lalu polling BscScan setiap ~20 detik mencari transaksi masuk ke wallet kamu dengan nominal yang cocok persis, lalu otomatis kreditkan saldo user begitu ketemu. User diminta mengirim nominal **PERSIS** sampai 4 desimal dan **wajib** pakai jaringan BEP20 (bukan TRC20/ERC20/lainnya).

### 3) Binance Pay (transfer C2C ke Binance ID pribadi)

Metode ini cocok kalau kamu **belum punya** merchant account Binance Pay (yang butuh pendaftaran bisnis) — cukup pakai akun Binance pribadi biasa. Bot memantau histori pembayaran masuk lewat endpoint **resmi** Binance "Get Pay Trade History" (`GET /sapi/v1/pay/transactions`), yang termasuk API biasa (bukan API khusus Merchant), jadi cukup buat 1 API key dari akun Binance kamu sendiri.

**Cara setup:**
1. Buka [binance.com](https://www.binance.com) → login → **Profile** (ikon pojok kanan atas) → **API Management**
2. **Create API** → pilih **System generated** → beri nama bebas (mis. `bot-topup-readonly`)
3. Setelah dibuat, di halaman edit permission API key itu, **centang HANYA** ✅ **Enable Reading**. **JANGAN** aktifkan "Enable Spot & Margin Trading" atau "Enable Withdrawals" sama sekali — fitur ini murni baca histori transaksi Pay, mengaktifkan izin lain cuma menambah risiko kalau API key sampai bocor
4. Copy **API Key** & **Secret Key**, isi ke `.env`:
   ```
   BINANCE_API_KEY=apikey_dari_binance
   BINANCE_API_SECRET=secretkey_dari_binance
   BINANCE_PAY_ID=1273523449
   ```
5. `BINANCE_PAY_ID` diisi Binance ID kamu sendiri (buka app Binance → tab **Pay** → ikon profil/QR di pojok kanan atas → nomor di bawah nama), ini yang ditampilkan ke buyer supaya mereka kirim lewat menu **Pay → Send**.

**Cara kerja pencocokan otomatis:** sama persis konsepnya dengan USDT/TON di atas — karena transfer Binance Pay tidak wajib disertai memo yang bisa diandalkan, bot menambahkan variasi kecil 4 desimal ke setiap permintaan topup supaya nominalnya unik, lalu polling histori Binance Pay tiap ~20 detik mencari transaksi masuk (`orderType: C2C`) dengan nominal yang cocok persis dalam 2 jam terakhir, lalu otomatis kreditkan saldo user begitu ketemu. User diminta mengirim nominal **PERSIS** sampai 4 desimal via menu **Pay → Send** ke Binance ID di atas (bukan P2P/transfer wallet biasa).

⚠️ **Catatan keamanan:** jangan pernah bagikan `BINANCE_API_SECRET` ke siapapun, dan simpan API key ini dengan permission **read-only** saja seperti instruksi di atas — kalau bocor pun, tidak ada yang bisa dilakukan penyerang selain membaca histori transaksi (tidak bisa trading/withdraw).

## Cara Pakai (User)

- `/start` → buka menu utama
- Pilih **🛒 Buy Produk** → tampil daftar semua produk (flat list) dengan harga & stok, 🟢 = stok tersedia, 🔴 = stok habis
- Pilih **👤 Profile** → tampil nama, username, Chat ID, saldo Wallet, total order, dan total referral, plus shortcut tombol **💳 Wallet** & **🧾 My Orders**
- Pencet produk → tampil **halaman deskripsi produk** (spesifikasi, syarat & ketentuan) dengan tombol:
  - **❗️ How to Use** → panduan cara redeem/aktivasi
  - **✅ Buy Now** → lanjut ke pilih jumlah
  - **‹ Back** → balik ke daftar produk
- Di halaman jumlah → tombol cepat (1/5/10/20/30/50/100) atau **Jumlah Custom**, lalu **Order Confirmation** (total harga, saldo wallet, stok) → **Place Order** / **Cancel Order**
- Pilih **💳 Wallet** → pilih metode **QRIS**, **USDT (BEP20)**, **TON**, atau **Binance Pay**:
  - **QRIS** → tampil menu **Pilih Nominal Deposit** dengan tombol cepat ($1/$5/$10/$25/$50/$100) atau **✏️ Nominal Kustom** untuk ketik nominal sendiri → bot langsung buat QRIS dengan tombol **❌ Batalkan Pembayaran** (batal = hapus QR & balik ke menu utama)
  - **USDT (BEP20)**, **TON**, dan **Binance Pay** → ketik nominal langsung, bot kasih nominal unik + alamat/Binance ID untuk dikirim
  - Saldo masuk **otomatis**, tidak perlu tunggu admin
- **🧾 My Orders** → tampil 5 order terakhir (Order ID, produk, jumlah, status) dengan tombol **🏅 Recover Product** (kirim ulang link/kode yang sudah pernah terkirim, cukup ketik Order ID-nya) dan **❌ Cancel** (balik ke menu utama)
- **❗️ How to Use** → tampil daftar semua produk, pencet salah satu untuk lihat panduan cara pakainya (teks yang sama dengan `howToUse` di halaman deskripsi produk), plus tombol **❌ Close menu** untuk tutup pesannya
- **🎁 Referral** → tampil link referral pribadi, jumlah referral, dan total penghasilan referral, plus tombol **📤 Bagikan Link Referral** untuk share langsung ke chat lain. Setiap teman yang buka bot lewat link itu untuk pertama kali otomatis menambah saldo pengundang sebesar `REFERRAL_REWARD`.
- **📞 Support** → tombol **Contact Support** langsung buka chat pribadi ke owner bot (admin pertama di `ADMIN_IDS`), plus tombol **‹ Kembali** ke menu utama.

## Warna Tombol Menu Utama 🎨

Sejak Telegram **Bot API 9.4** (rilis 9 Feb 2026), tombol inline keyboard bisa diberi warna latar lewat field `style` - berlaku untuk SEMUA bot, tidak butuh Telegram Premium sama sekali (beda dari custom emoji). Menu utama (`/start`) sudah pakai ini:
- Tombol biasa (Buy Produk, Saldo Saya, Wallet, My Orders) → `style: 'primary'` (biru)
- Tombol Referral → `style: 'success'` (hijau), supaya menonjol

Kalau mau ubah warna tombol lain, tinggal bungkus dengan helper `withStyle(button, 'primary' | 'success' | 'danger')` di `bot.js`.

## Emoji Premium (Custom Emoji) ⚡

Ada **2 mekanisme berbeda** untuk custom emoji Telegram Premium di bot ini:

### 1. Deskripsi Produk & How to Use — OTOMATIS, tanpa setting ID sama sekali

Saat admin (owner) isi teks **deskripsi produk** (lewat ➕ Tambah Produk) atau **How to Use** (lewat ✏️ Set How to Use), teks itu **bebas penuh** — boleh banyak baris, boleh tag HTML `<b>...</b>` untuk bold.

Kalau pas ngetik itu owner **memilih emoji premium langsung dari emoji panel Telegram Premium miliknya sendiri** (bukan sekadar ngetik karakter unicode biasa), Telegram otomatis menyertakan ID emoji tersebut di data pesan yang diterima bot. Bot langsung mengunci ID itu ke dalam teks yang disimpan — jadi emoji itu **langsung tampil premium ke semua pembeli**, tidak perlu isi/tempel ID ke file manapun.

Kalau owner cuma ngetik emoji unicode biasa (bukan pilih dari panel Premium), ya tetap tampil sebagai emoji biasa — itu wajar, karena memang bukan custom emoji.

Placeholder lama `{e}` (dulu wajib untuk munculin bullet "⚡" di depan tiap poin) masih didukung sebagai alias, tapi sekarang opsional — bullet itu pakai ID dari `EMOJI_ID_PRODUCT_DESC` di `emoji-id-teks.js` kalau di-set, atau fallback ke "⚡" biasa kalau kosong.

### 2. Teks Menu/Notifikasi & Ikon Tombol — manual, diisi di file

Untuk teks yang **bukan** ditulis bebas oleh admin (welcome `/start`, pesan "🎉 ORDER BERHASIL!", header admin panel, ikon di label tombol menu), custom emoji-nya diisi manual lewat 2 file:

| File | Variabel | Dipakai di |
|---|---|---|
| `emoji-id-teks.js` | `EMOJI_ID_MENU_NOTIF` | Bullet "⚡" bawaan bot di teks menu/notifikasi |
| `emoji-id-menu-inline.js` | `EMOJI_IDS` (object, 1 key per tombol) | Ikon di label tombol menu inline — tiap tombol (Buy Produk, Saldo Saya, How to Use, tombol-tombol admin panel, dll) punya key & ID sendiri-sendiri, jadi bisa beda-beda ikonnya per tombol. Lihat daftar key lengkap & komentarnya langsung di file itu. Diisi lewat field `icon_custom_emoji_id` (fitur Bot API 9.4). |

Kalau salah satu ID dikosongkan, otomatis fallback ke emoji unicode biasa (bukan error).

**Catatan penting soal tombol** — untuk tombol yang TIDAK diberi ikon lewat `withButtonIcon()`/`withButtonIconPreferProduct()` (mis. "❌ Cancel Order"), emoji di labelnya selalu tampil sebagai unicode standar — field `icon_custom_emoji_id` cuma berlaku untuk tombol yang secara eksplisit memakainya, ini keterbatasan dari Telegram Bot API sendiri, bukan bug di bot ini.

**Penting (terverifikasi dari [changelog resmi Bot API](https://core.telegram.org/bots/api-changelog#february-9-2026), Bot API 9.4, rilis 9 Februari 2026)** — bot **boleh** mengirim custom emoji di teks pesan, tapi **akun pemilik bot wajib berlangganan Telegram Premium**. Ini berlaku untuk kedua mekanisme di atas: baik ID yang di-hardcode manual, maupun ID yang otomatis ke-capture dari ketikan owner. Kalau owner belum Premium, custom emoji manapun otomatis fallback ke unicode biasa untuk slot itu — tidak akan error. Bot API 9.4 yang sama juga menambahkan field `icon_custom_emoji_id` untuk ikon di label tombol inline keyboard.

Cara dapat ID custom emoji untuk mekanisme manual (mekanisme 2 di atas):
1. Forward pesan yang berisi custom emoji tersebut ke bot seperti `@RawDataBot` atau `@userinfobot`
2. Cari field `custom_emoji_id` di bagian `entities` pada JSON yang dikirim balik
3. Tempel angka ID-nya ke `emoji-id-teks.js` (`EMOJI_ID_MENU_NOTIF`) dan/atau ke key yang sesuai di object `EMOJI_IDS` pada `emoji-id-menu-inline.js` (mis. `buy_produk`, `admin_statistik`, dst — lihat daftar lengkapnya di file tsb)

### Ikon tombol "Beli" ikut emoji produknya sendiri

Tombol **✅ Buy Now** (halaman deskripsi produk) dan **🛒 Order Sekarang** (notifikasi channel) PRIORITASKAN emoji premium milik produk itu sendiri (`product.emojiId` — sama yang dipakai `productEmojiHtml()` di bagian "Emoji premium PER PRODUK" atas), kalau produk itu punya. Jadi kalau produk X punya emoji premium ✨ sendiri, tombol Buy Now di halaman produk X otomatis pakai ikon ✨ itu juga — bukan cuma 1 ikon generik yang sama untuk semua produk.

Kalau produk itu belum punya `emojiId` sendiri, kedua tombol ini otomatis fallback ke ikon global key `buy_now` (diisi manual lewat `EMOJI_IDS` di `emoji-id-menu-inline.js`) — tidak ada error di kedua kasus.

## 🖼️ Logo Produk di Notifikasi Channel

Ini fitur yang **BEDA** dari emoji premium di atas — bukan `<tg-emoji>` (yang butuh Telegram Premium & tetap berupa karakter emoji), tapi GAMBAR logo aplikasi asli (mis. logo resmi Netflix, Spotify, Gemini), dikirim sebagai foto lewat notifikasi channel "🎉 New Purchase!".

**Cara setup:** `/admin` → 🖼️ Set Logo Produk → pilih produk → kirim URL gambar logo-nya (harus `http://` atau `https://`, disarankan hosting logo-nya sendiri supaya link-nya stabil). Ketik `-` kapan saja untuk menghapus logo dan balik pakai emoji biasa.

**Cara kerja:**
- Kalau produk yang dibeli punya logo tersimpan, notifikasi "🎉 New Purchase!" ke channel dikirim sebagai **foto** (logo jadi gambar), dengan teksnya jadi *caption* — captionnya tetap format HTML yang sama seperti biasa (`<b>`, `<code>`, dan `<tg-emoji>` premium tetap tampil normal di dalam caption).
- Kalau produk itu belum punya logo (atau logo belum diisi sama sekali), notifikasi tetap dikirim seperti biasa (teks + emoji `🛒`/`📦`), **tidak ada error**.
- Caption foto Telegram dibatasi 1024 karakter (beda dari teks biasa yang sampai 4096) — kalau isinya kebetulan lebih panjang dari itu, bot otomatis fallback kirim sebagai teks biasa tanpa logo, supaya notifikasi tetap terkirim.
- Kalau URL logo-nya ternyata rusak/tidak bisa diakses Telegram saat pengiriman, bot otomatis fallback kirim teks biasa juga — jadi notifikasi tidak pernah gagal terkirim gara-gara logo bermasalah.

Fitur ini cuma berlaku di notifikasi channel (New Purchase), belum di pesan "🎉 ORDER BERHASIL!" yang dikirim ke buyer — pesan itu sengaja tetap teks biasa karena sering membawa link/kode redeem yang panjang (bisa kepotong kalau dipaksa jadi caption foto).

## Menambah deskripsi & panduan untuk produk lain

Produk selain Gemini Premium 18 Bulan belum punya deskripsi custom (pakai teks default seadanya). Cara paling gampang: pakai `/admin` → ➕ Tambah Produk (atau ✏️ Set How to Use) dan ketik langsung di chat — kalau ada emoji premium yang dipilih dari panel Telegram Premium, otomatis kesimpan premium (lihat bagian di atas).

Kalau mau edit langsung lewat `data/db.json`, tambahkan field `description` dan `howToUse` pada varian yang dituju (string, boleh banyak baris, boleh tag HTML `<b>...</b>`). Untuk custom emoji lewat jalur ini, tempel manual tag `<tg-emoji emoji-id="...">🔥</tg-emoji>` di teksnya (ID didapat dengan cara yang sama seperti mekanisme 2 di atas), contoh:

```json
"description": "{e} Baris pertama\n<tg-emoji emoji-id=\"5373141891321699086\">🔥</tg-emoji> Baris kedua\n\n{e} <b>Catatan Penting:</b>\nIsi catatan di sini."
```

## 💾 Auto Backup

Fitur ini bikin file `.zip` berisi **seluruh source code project** (semua file & folder, kecuali `node_modules` dan `.npm` — jadi ukurannya kecil, bukan hitungan MB besar) lalu kirim otomatis ke sebuah group Telegram, tiap interval waktu (menit/jam) yang diatur admin. Berguna sebagai cadangan kalau server/VPS bermasalah — tinggal download zip terakhir dari group, extract, `npm install`, jalankan lagi.

**Setup lewat `/admin` → 💾 Auto Backup:**
1. **🆔 Atur Group ID** — isi Group ID Telegram tujuan (contoh: `-1001234567890`). Bot **wajib** sudah ditambahkan sebagai member di group itu duluan, kalau tidak pengiriman akan gagal. Cara dapat Group ID: invite bot ke group, forward pesan apapun dari group itu ke `@userinfobot` atau `@RawDataBot`, lihat field `id`-nya.
2. **⏱️ Atur Interval** — ketik interval dalam menit, contoh `60` untuk tiap jam, `15` untuk tiap 15 menit, `1440` untuk tiap hari.
3. **▶️ Aktifkan** — nyalakan jadwal otomatisnya (tombol ini terkunci sampai Group ID diisi).
4. **📤 Backup Sekarang** — trigger manual kapan saja, tanpa harus nunggu jadwal.

Semua pengaturan (aktif/nonaktif, interval, Group ID) tersimpan permanen di `data/db.json`, jadi tetap kepakai walau bot di-restart. `BACKUP_GROUP_ID` & `BACKUP_INTERVAL_MINUTES` di `.env` sifatnya opsional, cuma dipakai sebagai isian awal saat run pertama kali.

**⚠️ Catatan keamanan:** `.env` **TIDAK ikut** dalam file backup (dikecualikan otomatis - lihat `backup.js`), karena berisi token bot & API key sensitif lain. Konsekuensinya: **restore dari zip backup TIDAK otomatis mengembalikan `.env`** - admin wajib isi ulang `.env` manual di server baru (dari catatan pribadi/password manager sendiri, BUKAN dari chat/zip manapun). File backup tetap berisi *full* source code lain + `data/db.json` (data user & saldo), jadi tetap pastikan group tujuan bersifat **privat** dan hanya berisi orang yang benar-benar kamu percaya.

**Data user & saldo ikut ter-backup FULL** — karena `data/db.json` (tempat semua saldo Wallet, riwayat order, deposit, produk, dst disimpan) ikut masuk ke dalam zip apa adanya (satu-satunya yang dikecualikan cuma `node_modules` & `.npm`, yang isinya cuma dependency library, bukan data toko). Jadi kalau server rusak/hilang, tinggal extract zip backup terakhir, taruh lagi `data/db.json` hasil extract-an ke folder project yang baru, `npm install`, jalankan `npm start` — saldo & data semua user balik utuh persis seperti kondisi terakhir sebelum backup itu dibuat. Karena itu juga penting jaga interval backup cukup rapat (misal tiap 1 jam) supaya kalau ada apa-apa, data yang "hilang" paling banter cuma transaksi dalam 1 jam terakhir saja.

## 📢 Broadcast

Kirim 1 pesan ke **SEMUA user** yang pernah `/start` bot sekaligus, lewat `/admin` → 📢 Broadcast.

**Cara pakai:**
1. Pencet 📢 Broadcast, lalu kirim pesannya langsung ke bot:
   - **Teks saja** — ketik bebas.
   - **Foto + caption** — kirim sebagai foto Telegram biasa, isi captionnya.
   - **Foto saja** — kirim foto tanpa caption.
2. Teks/caption **bebas** — boleh banyak baris, boleh tag HTML standar Telegram (`<b>`, `<i>`, `<u>`, `<s>`, `<a href="...">`, `<code>`, `<blockquote>` untuk kutipan, dll), dan kalau kamu pilih **emoji premium** langsung dari panel emoji Telegram Premium kamu sendiri (bukan sekadar ngetik unicode biasa), emoji itu otomatis ikut kesimpan sebagai premium juga saat dikirim ke semua penerima — sama seperti mekanisme di [Emoji Premium](#emoji-premium-custom-emoji-⚡) bagian 1.
3. Bot langsung kasih **preview** persis seperti yang bakal diterima user, plus tombol **✅ Ya, Kirim Sekarang** / **❌ Batal**.
4. Setelah dikonfirmim, bot kirim ke semua user satu-satu (ada jeda kecil antar pesan biar tidak kena rate limit Telegram), lalu laporkan ringkasan **berhasil vs gagal** (gagal biasanya berarti user tersebut sudah blokir/hapus bot — bukan error di sisi kamu).

## Cara Pakai (Admin)

Kirim `/admin` di chat pribadi dengan bot untuk membuka **panel admin full inline** (semua lewat tombol, tanpa perlu hafal command):

| Tombol | Fungsi |
|---|---|
| 📦 Daftar Produk | Lihat semua produk beserta id, harga, dan stok |
| ➕ Tambah Produk | Bikin produk baru — cuma 3 langkah: **nama → harga → deskripsi** |
| 🗑️ Hapus Produk | Pilih produk dari daftar, lalu konfirmasi hapus |
| 📥 Tambah Stock | Pilih produk, lalu kirim link/kode redeem satu-satu atau bulk |
| ➕ Tambah Varian (produk multi-varian) | Untuk kasus lanjutan: tambah varian ke-2/ke-3 dst ke produk yang sudah ada (misal Netflix Sharing vs Private) |
| 🖼️ Set Logo Produk | Isi URL gambar logo aplikasi (mis. logo resmi Netflix/Spotify/Gemini yang kamu hosting sendiri) per produk — dipakai di notifikasi channel "🎉 New Purchase!" supaya tampil sebagai gambar, bukan cuma emoji. Ketik `-` untuk menghapus (balik pakai emoji biasa) |
| 💰 Atur Saldo User | Tambah/kurangi saldo user tertentu secara manual |
| 📜 Log Pengiriman | Lihat 10 order auto-delivered terakhir beserta link yang terkirim |
| 🔍 Cek Order ID | Cari 1 order spesifik by ID, lihat detail & link yang terkirim |
| 📊 Statistik | Total user, total saldo beredar, total order, total omzet, jumlah topup Wallet yang masih pending (menunggu pembayaran QRIS/USDT) |
| 🎁 Set Tier Diskon Grosir | Ketik langsung 3 harga jual USD (1-49 / 50-499 / 500+ pcs) per varian — untuk varian Supplier API, ada tombol **🔒 Kunci Harga Manual** supaya tidak ketimpa auto-sync — lihat bagian [🎁 Tier Diskon Grosir & Markup Otomatis](#-tier-diskon-grosir--markup-otomatis) |
| 🔌 Supplier API (AIVerse Hub) | Hubungkan/putus varian produk lokal ke `service_id` AIVerse Hub (dengan tampilan margin modal vs harga jual + tombol markup cepat saat link), cek saldo toko di AIVerse Hub, lihat **🧾 Riwayat Order**, **📊 Statistik**, dan **🔍 Cek Order ID (API)** — lihat bagian [🔌 Supplier API](#-supplier-api-aiverse-hub) |
| 🔌 Canboso API | Supplier kedua (terpisah dari AIVerse Hub) — hubungkan/putus varian produk lokal ke produk Canboso, atur harga, refresh modal & stok — lihat bagian [🔌 Canboso API](#-canboso-api-supplier-kedua) |
| 💾 Auto Backup | Aktif/nonaktifkan backup terjadwal, atur interval (menit), atur Group ID tujuan, atau trigger backup manual — lihat bagian [💾 Auto Backup](#-auto-backup) |
| 📢 Broadcast | Kirim pesan (teks atau foto+caption) ke SEMUA user sekaligus — lihat bagian [📢 Broadcast](#-broadcast) |

`/cancel` masih tersedia untuk membatalkan input teks yang sedang berjalan (misal salah ketik saat isi harga/stok).

Saat ada **order baru**, admin otomatis dapat notifikasi berisi detail user & produk.

### ➕ Tambah Produk (nama + harga + deskripsi) — DIPERBARUI

Sekarang bikin produk baru cuma butuh 3 langkah, tanpa perlu mikirin id/varian/stok dulu:

1. `/admin` → **➕ Tambah Produk**
2. Ketik **nama produk**, contoh: `Gemini Pro 18 Bulan`
3. Ketik **harga dalam USD** (angka saja, boleh desimal), contoh: `5.99`
4. Ketik **deskripsi** (bebas, boleh banyak baris & tag HTML `<b>...</b>`), atau ketik `-` untuk lewati dulu

Bot otomatis bikin 1 produk lengkap dengan 1 varian default berisi harga & deskripsi itu, stok mulai dari **0**. Langkah berikutnya tinggal isi stok lewat **📥 Tambah Stock**.

Kalau butuh produk dengan beberapa pilihan harga/varian sekaligus (misal Netflix Sharing vs Private), pakai tombol **➕ Tambah Varian (produk multi-varian)** untuk menambah varian ke-2 dst ke produk yang sudah dibuat.

### 📥 Tambah Stock — pilih produk, lalu pilih cara (Link/Kode atau Angka Manual)

"Tambah Stock" dipakai untuk nambah stok produk yang sudah ada (misalnya `Gemini Pro 18 Bulan`), lewat **2 cara** yang bisa dipilih tiap kali admin nambah stok:

- **📋 Link/Kode (Auto-Kirim)** — isi stok link/kode redeem beneran, supaya pengiriman ke pembeli **otomatis** tanpa admin perlu kirim manual.
- **🔢 Angka Saja (Manual)** — BARU, cuma nambah **jumlah** stok tanpa link/kode apapun, buat produk yang memang dikirim admin sendiri secara manual ke buyer setelah order masuk (bukan auto-delivery).

Alurnya:
1. `/admin` → **📥 Tambah Stock**
2. Pilih produk. Kalau produk itu cuma punya 1 varian (hasil "➕ Tambah Produk" biasa), bot langsung lanjut. Kalau produk multi-varian (misal Netflix), bot minta pilih varian dulu.
3. Bot tampilkan layar pilih cara — pencet **📋 Kirim Link/Kode (Auto-Kirim)** atau **🔢 Tambah Angka Saja (Manual)**.
4a. Kalau pilih **📋 Link/Kode**: kirim link/kode redeem, ada 2 cara (boleh dicampur bebas):

   **Cara 1 — satu-satu (1/1):** kirim 1 link per pesan, ulangi tiap kali ada link baru.
   ```
   Pesan 1: https://link-redeem-1...
   (bot balas konfirmasi)
   Pesan 2: https://link-redeem-2...
   (bot balas konfirmasi lagi)
   ```

   **Cara 2 — bulk (banyak sekaligus):** kirim banyak link dalam 1 pesan, **1 baris = 1 unit stok**.
   ```
   https://link-redeem-1...
   https://link-redeem-2...
   https://link-redeem-3...
   ```
   Bot balas konfirmasi jumlah yang berhasil ditambah + total stok auto-kirim sekarang. Bisa lanjut kirim baris lagi, atau `/cancel` untuk selesai.

4b. Kalau pilih **🔢 Angka Saja (Manual)**: cukup ketik satu angka (mis. `10`), bot langsung nambah `variant.stock` sejumlah itu tanpa link/kode. Bisa ketik angka lagi buat nambah lebih banyak, atau `/cancel` untuk selesai. ⚠️ Kalau varian yang sama juga dipakai lewat cara 📋 Link/Kode, stok manual di sini bisa ketimpa jadi jumlah link/kode yang tersimpan — jangan campur 2 cara ini di 1 varian yang sama.

**Begitu stok berhasil ditambah lewat cara MANAPUN di atas**, bot otomatis kirim notifikasi **"🔔 STOK BARU TERSEDIA!"** (nama produk, jumlah ditambahkan, total stok, harga, semua ikonnya pakai custom emoji Premium lewat "🎨 Kelola Emoji ID" → grup "🔔 Notifikasi Live Stock") + tombol inline **✅ Buy Now** ke **SEMUA user terdaftar** — pencet tombolnya langsung masuk ke alur pilih jumlah beli produk itu. Pengiriman broadcast-nya jalan di belakang layar (tidak bikin admin nunggu), dan admin yang mentrigger dapat ringkasan berhasil/gagal setelah broadcast-nya selesai.

Begitu ada user beli produk yang stoknya sudah diisi dengan cara ini:
- Saldo user langsung dipotong, link teratas (FIFO) langsung diambil & dikirim ke chat user dalam pesan **"🎉 ORDER BERHASIL!"** yang sudah diformat rapi + emoji premium ⚡, lengkap dengan detail produk, jumlah, total, dan ID order.
- Admin dapat notifikasi ringan (`✅ Auto-delivered`) — **tidak perlu kirim manual lagi**.
- Kalau stok link ternyata kurang dari jumlah yang dibeli (atau produk belum pernah diisi lewat menu ini), bot otomatis fallback ke alur lama: user tetap dapat pesan order berhasil, tapi admin dapat notifikasi untuk kirim akun/detail secara manual. Tidak ada error atau stok yang salah potong di kedua kasus ini.

Stok yang tersisa lewat cara ini juga muncul di **📦 Daftar Produk** dengan tag `🤖 auto-kirim: N`.

### 📜 Log Pengiriman & 🔍 Cek Order ID — BARU

Setiap kali produk terkirim otomatis, bot mencatat **link/kode persis apa yang dikirim ke order ID mana** (bukan cuma jumlahnya) — jadi kalau ada user komplain "link saya nggak jalan", admin bisa langsung audit tanpa nebak-nebak.

- **📜 Log Pengiriman** — tampilkan 10 order auto-delivered terakhir: order ID, user, produk, waktu, dan link/kode persis yang terkirim.
- **🔍 Cek Order ID** — ketik ID order tertentu (bisa dari notifikasi order baru atau riwayat pembelian user), bot balas detail lengkap order itu — kalau auto-delivered, link yang dikirim ikut ditampilkan; kalau manual, ditandai "Dikirim manual oleh admin".

Saat ada **topup Wallet berhasil** (QRIS atau USDT), saldo user bertambah otomatis tanpa notifikasi/aksi admin.

## 🔌 Supplier API (AIVerse Hub)

Fitur ini menghubungkan salah satu varian produk lokal ke sebuah `service_id` di [AIVerse Hub](https://aiversehub.store) (`AIVERSEHUB_API_KEY` & `AIVERSEHUB_BASE_URL` di `.env`). Begitu ada buyer beli varian yang terhubung, bot **otomatis pesan lewat API AIVerse Hub** (bukan dari stok lokal) dan langsung teruskan kode/link yang dibalas API itu ke buyer — mirip dropship otomatis. Saldo buyer baru dipotong **setelah** order API sukses, jadi tidak ada saldo kepotong tanpa produk terkirim kalau API gagal (saldo toko di AIVerse Hub habis, stok remote kosong, dsb) — dalam kasus itu admin dapat notifikasi dan saldo buyer tetap utuh.

Modal & stok varian yang terhubung disinkron **otomatis** tiap `SUPPLIER_SYNC_INTERVAL_MINUTES` menit (default 10, isi 0 di `.env` untuk matikan) — tidak perlu lagi klik "🔄 Refresh Modal & Stok" manual supaya angka stok yang buyer lihat di daftar produk selalu live. Kalau ada link yang rusak (service_id sudah tidak ada lagi di AIVerse Hub) saat auto-sync jalan, semua admin dapat notifikasi otomatis; tombol refresh manual tetap ada di menu Supplier API kalau mau cek kapan saja di luar jadwal.

**🔔 Notifikasi Live Stock ke SEMUA user** — begitu auto-sync ini mendeteksi TOTAL stok 1+ varian berubah (naik ATAU turun) dibanding sync sebelumnya, bot otomatis broadcast pesan "STOK DIPERBARUI!" (nama produk, stok lama → baru, harga) + tombol **✅ Buy Now** per varian ke SEMUA user terdaftar — sama mekanismenya dengan notifikasi live stock di 📥 Tambah Stock manual (lihat bagian itu untuk detail cara kerja broadcast & custom emoji Premium-nya). Kalau beberapa varian berubah di 1 siklus sync yang sama, semuanya digabung jadi 1 pesan (bukan pesan terpisah per varian) supaya user tidak kebanjiran. ⚠️ Ini jalan tiap kali sync mendeteksi PERUBAHAN angka (termasuk naik/turun kecil, bukan cuma pas restock dari 0) — kalau `SUPPLIER_SYNC_INTERVAL_MINUTES` diset rapat dan stok Supplier sering fluktuasi, user bisa dapat notifikasi cukup sering; atur interval sync sesuai kenyamanan.

**Setup lewat `/admin` → 🔌 Supplier API (AIVerse Hub):**
1. **➕ Hubungkan Produk** — pilih produk lokal → pilih varian (kalau produk multi-varian) → pilih service dari daftar produk AIVerse Hub (diambil live lewat API). Stok lokal varian ini boleh dibiarkan 0 — buyer akan melihat status stok **"🔌 Auto (API)"**, bukan angka 0, dan tombol beli tidak akan terkunci.

   Begitu berhasil dihubungkan, bot langsung tampilkan **perbandingan modal vs harga jual** (margin), dengan ⚠️ peringatan jelas kalau harga jual saat ini sama dengan atau di bawah harga modal AIVerse Hub (supaya tidak kejadian jual rugi tanpa sadar). Di layar yang sama ada tombol markup cepat **+10% / +20% / +30% / +50%** (dihitung dari harga modal) buat langsung set harga jual, atau **✏️ Harga Custom** untuk ketik nominal sendiri.
2. **🗑️ Putus** — lepaskan sebuah varian dari Supplier API, varian itu balik pakai stok lokal seperti biasa.
3. **🧾 Riwayat Order** — histori order toko kita di sisi AIVerse Hub (order ID, produk, jumlah, nominal, status, waktu), dengan tombol navigasi ‹ Sebelumnya / Berikutnya ›.
4. **📊 Statistik** — ringkasan deposit & penjualan (hari ini/7 hari/30 hari/1 tahun/sepanjang waktu) plus daftar produk terlaris di sisi AIVerse Hub.
5. **🔍 Cek Order ID (API)** — ketik 1 Order ID milik AIVerse Hub (bukan Order ID lokal bot), bot balas detail order itu (service, jumlah, nominal, status, produk yang terkirim) langsung dari `GET /api/v1/order/{id}`. Berguna kalau buyer komplain kode dari supplier tidak jalan, tanpa perlu buka dashboard AIVerse Hub.
6. **🔄 Refresh Modal & Stok** — muncul kalau sudah ada minimal 1 varian terhubung. Panggil `GET /api/v1/products` **satu kali** (bukan per-varian, hemat rate limit 3 req/detik AIVerse Hub) lalu update harga modal SEMUA varian yang terhubung sekaligus, tampilkan margin terbaru tiap varian, dan kasih ⚠️ kalau stok di AIVerse Hub tersisa ≤5 (biar bisa top up saldo di sana sebelum buyer gagal beli) atau kalau service-nya ternyata sudah dihapus dari AIVerse Hub.

Tombol **🗑️ Putus** sekarang minta konfirmasi dulu ("✅ Ya, Putuskan" / "❌ Batal") sebelum benar-benar memutuskan link — sama seperti pola konfirmasi di 🗑️ Hapus Produk, supaya tidak kepencet tidak sengaja.

Halaman utama menu ini juga menampilkan status koneksi (🟢 terhubung + saldo toko di AIVerse Hub, atau 🔴 kalau gagal cek koneksi) dan daftar semua varian yang sedang terhubung **beserta margin masing-masing** (modal, harga jual, untung/rugi per pcs) — dihitung dari harga modal yang di-snapshot saat link pertama kali dibuat, dan bisa disegarkan kapan saja lewat 🔄 Refresh Modal & Stok di atas.

**Catatan harga jual:** harga dasar (tier ke-1) ke buyer diset manual lewat 💲 Set Harga Produk (menu admin utama) atau tombol markup cepat saat link, dan TIDAK PERNAH otomatis berubah untuk varian yang **bukan** terhubung Supplier API. Untuk varian yang **terhubung** Supplier API dan tier harganya dihitung dari markup% (📊 Atur Markup 3-Tier), harga jual justru SENGAJA ikut naik/turun otomatis tiap auto-sync supaya selalu sesuai modal terbaru — kecuali kamu kunci lewat 🔒 Kunci Harga Manual. Detail lengkapnya di bagian [🎁 Tier Diskon Grosir & Markup Otomatis](#-tier-diskon-grosir--markup-otomatis) di bawah.

## 🎁 Tier Diskon Grosir & Markup Otomatis

Tiap varian punya harga bertingkat berdasarkan jumlah beli: **1-49 pcs / 50-499 pcs / 500+ pcs**, masing-masing bisa beda harga (diskon grosir). Ada 2 cara mengisinya, plus 1 pengaman khusus varian Supplier API:

**1. 🎁 Set Tier Diskon Grosir** — `/admin` → pilih produk/varian → ketik 3 harga jual USD langsung dipisah koma, contoh `0.65,0.69,0.65` (artinya 1-49 pcs = $0.65, 50-499 pcs = $0.69, 500+ pcs = $0.65). Cocok untuk semua jenis varian, termasuk yang tidak terhubung Supplier API.

**2. 📊 Atur Markup 3-Tier** — khusus varian yang terhubung Supplier API. Ketik 3 angka **persen markup** dipisah koma, contoh `10,7,5` (artinya tier 1-49 = modal+10%, 50-499 = modal+7%, 500+ = modal+5%). Harga langsung dihitung dari modal Supplier SAAT INI, dan markup-nya tersimpan permanen untuk dipakai ulang tiap auto-sync berikutnya — jadi harga jual otomatis ikut naik/turun mengikuti modal live Supplier, tidak perlu diketik ulang manual tiap kali modal berubah.

**⚠️ Interaksi dengan auto-sync Supplier API:** kalau kamu isi harga lewat cara 1 (🎁 Set Tier Diskon Grosir) untuk varian yang terhubung Supplier API, harga itu akan **TERTIMPA lagi** begitu auto-sync berikutnya jalan (tiap `SUPPLIER_SYNC_INTERVAL_MINUTES` menit, atau saat klik "🔄 Refresh Modal & Stok" manual) — karena sync selalu menghitung ulang tier dari markup% (default `DEFAULT_SUPPLIER_TIER_MARKUP` di `config.js`, kecuali sudah pernah diisi lewat cara 2 di atas). Ini **disengaja**, bukan bug — tujuannya supaya harga jual varian Supplier API selalu ikut modal terbaru dan tidak basi/rugi kalau modal naik.

Kalau kamu memang ingin harga tier tertentu **tidak** ikut auto-sync (misalnya harga promo jangka pendek), tekan tombol **🔒 Kunci Harga Manual** di layar "🎁 Set Tier Diskon Grosir" setelah set harganya. Selama dikunci:
- Tier harga (1-49/50-499/500+) dijamin **tidak** dihitung ulang oleh auto-sync maupun refresh manual.
- Modal (`supplierCost`) dan **stok** varian tetap disinkron seperti biasa — cuma tier harga jual yang di-skip.
- Kalau modal Supplier melonjak/anjlok ≥20% dibanding sync sebelumnya, admin tetap dapat notifikasi (supaya bisa cek margin manual), tapi teksnya menegaskan harga jual TIDAK ikut berubah karena dikunci.
- Tekan tombol yang sama (sekarang **🔓 Buka Kunci Harga Manual**) kapan saja untuk kembali ke mode ikut-markup otomatis.

Status kunci (🔒/🔓) selalu ditampilkan di layar "🎁 Set Tier Diskon Grosir" dan ditandai `🔒` di laporan hasil sync Supplier API, jadi mudah dicek varian mana saja yang sedang dikunci.

## 🔌 Canboso API (supplier kedua)

Supplier KEDUA yang terpisah dari Supplier API (AIVerse Hub) di atas — pola kerjanya sama (link varian lokal ke produk remote, auto-order + auto-forward ke buyer, saldo buyer baru dipotong setelah order API sukses), tapi menghubungkan ke [Canboso](https://canboso.com) (`CANBOSO_API_KEY` & `CANBOSO_BASE_URL` di `.env`). Dokumentasi resmi Canboso: https://canboso.com/api/swagger.

Canboso cuma expose 2 endpoint publik (`GET /api/v2/telegram-buyer/products` dan `POST /api/v2/telegram-buyer/purchase`), jadi menu **🔌 Canboso API** di `/admin` lebih ringkas dari Supplier API — tidak ada Riwayat Order/Statistik/Cek Order ID API. Auto-sync modal & stok sekarang **ada** (lihat `CANBOSO_SYNC_INTERVAL_SECONDS` di bawah), plus tombol **🔄 Refresh Harga & Stok** untuk trigger manual kapan saja.

**Auto-sync modal & stok** — mirip `SUPPLIER_SYNC_INTERVAL_MINUTES` di Supplier API (AIVerse Hub), tapi satuannya **detik** lewat `CANBOSO_SYNC_INTERVAL_SECONDS` di `.env` (default `60` = tiap 1 menit). Ini murni buat menyegarkan angka yang admin lihat di panel — buyer sendiri SUDAH selalu dapat cek stok live tiap kali buka halaman produk (di-cache 20 detik, lihat `supplierCanboso.js`), jadi tidak wajib diset rapat-rapat. Isi `0` untuk matikan (kembali ke refresh manual saja). Nilai 1-9 detik otomatis dinaikkan ke minimum 10 detik supaya tidak memicu rate limit 429 di Canboso. Kalau ada link yang rusak atau field stok yang gagal terbaca, semua admin dapat notifikasi otomatis (dengan cooldown, tidak spam tiap sync).

**🔔 Notifikasi Live Stock ke SEMUA user** — sama seperti di Supplier API (AIVerse Hub) di atas: begitu auto-sync ini mendeteksi TOTAL stok 1+ varian berubah, bot broadcast "STOK DIPERBARUI!" + tombol Buy Now ke semua user. ⚠️ Karena `CANBOSO_SYNC_INTERVAL_SECONDS` defaultnya cuma 60 detik (jauh lebih rapat dari Supplier API yang defaultnya 10 MENIT), fitur ini berpotensi jauh lebih sering ngirim notifikasi kalau stok Canboso-nya sering naik-turun — pertimbangkan naikkan intervalnya di `.env` kalau notifikasinya kerasa terlalu sering.

**Setup lewat `/admin` → 🔌 Canboso API:**
1. **➕ Hubungkan Produk** — pilih produk lokal → pilih varian → pilih produk dari daftar Canboso (diambil live lewat API). Sama seperti Supplier API, langsung ada perbandingan modal vs harga jual + tombol markup cepat **+10% / +20% / +30% / +50%** atau **✏️ Harga Custom**.
2. **💲 Harga** — atur ulang harga jual kapan saja tanpa perlu putus-hubung ulang.
3. **🗑️ Putus** (dengan konfirmasi) — lepaskan varian dari Canboso, balik pakai stok lokal.
4. **🔄 Refresh Harga & Stok** — ambil ulang daftar produk Canboso dan update modal + stok semua varian yang terhubung sekaligus (harga jual TIDAK ikut berubah otomatis — beda dari Supplier API, di sini kamu yang atur ulang manual kalau modal berubah signifikan).

**Penting soal wallet:** saldo yang dipakai untuk `POST /purchase` adalah **saldo wallet akun Canboso ini** (bukan saldo Wallet buyer di bot) — wajib di-top-up dulu langsung dari sisi Canboso sebelum fitur ini dipakai, persis seperti saldo toko di AIVerse Hub.

**Catatan auth API:** API key Canboso dikirim lewat 2 header sekaligus (`Authorization: Bearer <key>` dan `X-API-Key: <key>`) di `supplierCanboso.js` supaya tetap jalan apapun konvensi yang dipakai — kalau ternyata Canboso butuh skema lain, cukup sesuaikan di 1 tempat itu.

## Produk default

Bot sudah terisi 3 kategori contoh (bisa diedit lewat `/addproduct`, `/addvariant`, atau langsung edit `data/db.json`):

- ✨ Gemini Premium — 18 Bulan
- 🎬 Netflix Premium — 1 Bulan (Sharing/Private)
- 🎵 Spotify Premium — 1 Bulan

## Catatan

- Semua data (saldo, produk, order, deposit/topup) tersimpan di `data/db.json`. Backup file ini secara berkala.
- Bot pakai `polling`, jadi cukup jalankan `npm start` di server/VPS yang nyala terus (atau pakai PM2 agar auto-restart).
- Kalau bot di-restart saat ada topup yang masih pending (belum dibayar), bot otomatis melanjutkan pemantauan status QRIS/USDT-nya begitu nyala lagi — tidak hilang begitu saja.
