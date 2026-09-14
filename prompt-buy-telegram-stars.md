# Fitur: Buy Telegram Stars — via Saldo Stars Userbot (Telegram MTProto resmi)

**Konteks:** Menambahkan fitur baru ke bot Telegram Node.js yang sudah ada (`bot.js`, `payment.js`, `lang.js`, `db.js`, `userbot.js`). Mengikuti pola arsitektur fitur **Buy Gift** yang sudah berjalan di `userbot.js`.

> **❌ STATUS: FITUR SUDAH DIHAPUS TOTAL** (termasuk mode TON/Fragment yang sempat ditambahkan setelahnya - lihat `prompt-fragment-ton-auto.md`). Seluruh kode terkait di `bot.js`, `db.js`, `userbot.js`, `config.js`, `lang.js`, `backup.js` sudah dibersihkan, dan file `ton-fragment.js`/`generate-ton-wallet.js` sudah dihapus dari project. Dokumen ini disimpan HANYA sebagai arsip riwayat spesifikasi - jangan dipakai sebagai acuan implementasi ulang tanpa restart spesifikasi dari awal.

---

## 0. Catatan Penyesuaian Spesifikasi (WAJIB DIBACA)

Spesifikasi awal meminta pembelian Stars dieksekusi lewat **transaksi TON ke smart contract Fragment.com** (wallet TON toko + seed phrase di `.env`). Setelah meninjau kode yang sudah ada, pendekatan itu **diganti** dengan pendekatan yang lebih aman dan konsisten dengan arsitektur bot ini. Alasannya:

1. **Fragment.com tidak punya API/SDK resmi** untuk membeli Stars secara terprogram lewat smart contract atas nama username tujuan. Membangun `buildAndSignTx()` untuk ini berarti reverse-engineering perilaku on-chain Fragment yang tidak didokumentasikan — kalau Fragment mengubah skema kontraknya, dana TON toko bisa hilang tanpa jalan recovery, dan tidak ada cara memvalidasi hasilnya dari sisi kita.
2. Bot ini **sudah punya** fitur "🎁 Buy Gift" (lihat `userbot.js`) yang berjalan lewat akun userbot GramJS (MTProto, login pakai akun Telegram asli) dan sudah terbukti jalan. Telegram punya method MTProto **resmi** untuk mengirim Stars polos langsung ke saldo user lain: `InputInvoiceStarsGift` + `payments.GetPaymentForm` + `payments.SendStarsForm` — persis fitur "Gift Stars" yang ada di aplikasi Telegram resmi.
3. Dengan pendekatan ini, **tidak dibutuhkan wallet TON, seed phrase, ataupun akses Fragment.com sama sekali**. Modal Stars berasal dari saldo Stars akun userbot yang sama dipakai fitur Buy Gift (admin top up manual lewat Settings → Stars di akun userbot tersebut, sama seperti sekarang).

Implikasi ke seluruh dokumen ini: setiap referensi "Fragment", "TON", "smart contract", "seed phrase" pada rencana awal **tidak berlaku lagi** dan digantikan versi di bawah.

---

## 1. Alur Pengguna (final)

1. User pilih **"⭐ Buy Telegram Stars"** dari menu utama → callback `stars:menu`
2. User pilih nominal preset (`stars:preset:<jumlah>`) atau tombol **"✏️ Jumlah Custom"** (`stars:custom` → input teks bebas, pending action `stars_amount`)
3. User input username/ID Telegram tujuan penerima (pending action `stars_target`)
4. Bot tampilkan ringkasan: jumlah Stars, target, harga (modal Stars × kurs + markup toko), minta konfirmasi → `stars:confirm:<token>`
5. Setelah konfirmasi:
   - Cek saldo wallet user cukup — kalau kurang, tampilkan tombol quick-topup sejumlah kekurangan (pending action **tidak** dihapus, supaya user tinggal tap ulang setelah top up)
   - Cek saldo Stars akun userbot cukup **sebelum** memotong saldo user — kalau kurang, order ditolak dengan pesan jelas, saldo user **tidak** dipotong sama sekali
   - Potong saldo wallet user
   - Eksekusi pengiriman Stars via `userbot.sendStarsGiftToUser()` (MTProto resmi, dari saldo Stars userbot)
   - Sukses → kirim notifikasi sukses ke user + notifikasi ke admin
   - Gagal → refund saldo user otomatis + kirim notifikasi gagal ke user + notifikasi ke admin
   - Notifikasi admin (kedua kasus) berisi: username/ID buyer, jumlah Stars, target, harga jual, order ID, status (+ pesan error kalau gagal)

Tidak ada polling blockchain (tidak relevan lagi) — `payments.SendStarsForm` bersifat sinkron: hasilnya (sukses/gagal) langsung diketahui dari response API, tanpa perlu menunggu konfirmasi on-chain.

## 2. Modul yang Diperluas — `userbot.js` (bukan modul baru `supplierFragmentStars.js`)

Karena modal Stars berasal dari akun userbot sendiri (bukan API pihak ketiga), tidak dibutuhkan modul "supplier" terpisah. Dua fungsi baru ditambahkan langsung ke `userbot.js`, mengikuti pola `sendGiftToUser()` yang sudah ada:

- `getStarsGiftPresets()` — ambil daftar preset nominal Stars dari Telegram (`payments.GetStarsGiftOptions`), dengan fallback aman ke array kosong kalau method ini gagal/berbeda skema (pemanggil lalu fallback ke preset statis dari `.env`)
- `sendStarsGiftToUser({ targetUsernameOrId, stars })` — resolve target jadi `InputUser`, bangun `InputInvoiceStarsGift`, lalu `payments.GetPaymentForm` + `payments.SendStarsForm` (dibayar otomatis dari saldo Stars userbot, sama seperti gift)

Fungsi `getUserbotStarsBalance()` yang sudah ada dipakai ulang untuk pre-check saldo — **satu pool saldo Stars yang sama** dipakai bersama fitur Buy Gift, jadi notifikasi "Stars menipis" (`maybeNotifyLowStars()`) otomatis relevan untuk kedua fitur tanpa perubahan tambahan.

## 3. Perubahan per File (final)

| File | Perubahan |
|---|---|
| `config.js` | Env baru: `STARS_MARKUP_PCT`, `STARS_GIFT_MIN`, `STARS_GIFT_MAX`, `STARS_GIFT_PRESETS` |
| `userbot.js` | Fungsi baru: `getStarsGiftPresets()`, `sendStarsGiftToUser()` |
| `bot.js` | Tombol menu utama `⭐ Buy Telegram Stars`; handler `stars:menu`, `stars:preset:<n>`, `stars:custom`, `stars:confirm:<token>`; handler input teks untuk pending `stars_amount` & `stars_target`; fungsi `starsPriceUsd()`, `starsMenuKeyboard()`, `showStarsConfirmation()`, `executeStarsSend()` |
| `lang.js` | Key bahasa ID+EN baru untuk seluruh teks alur (menu, ask amount, invalid amount, ask target, invalid target, ringkasan konfirmasi, sukses, gagal+refund, stok Stars habis) |
| `db.js` | Array baru `starsOrders` (migrasi otomatis di `readDb()`) + `createStarsOrder()`, `updateStarsOrder()`, `getStarsOrdersByUser()`, `getStarsPricingSettings()`/`setStarsPricingSettings()` (pola identik `giftOrders`/`giftPricing`, tapi terpisah) |
| `payment.js` | **Tidak ada perubahan** — potong/refund saldo cukup pakai `db.updateBalance()` yang sudah ada (sama seperti alur Buy Gift), tidak perlu fungsi lock terpisah karena sudah ditangani lock `pendingOrderConfirms` di `bot.js` (lihat bagian 6) |

## 4. ENV Baru (final)

```
STARS_MARKUP_PCT=20          # markup % di atas modal Stars, TERPISAH dari GIFT_MARKUP_PCT
STARS_GIFT_MIN=50            # jumlah Stars minimum per order
STARS_GIFT_MAX=1000000       # jumlah Stars maksimum per order
STARS_GIFT_PRESETS=50,100,250,500,1000   # nominal preset tombol cepat (fallback kalau preset live Telegram gagal diambil)
```

Tidak ada `TON_WALLET_SEED` / `TON_WALLET_ADDRESS` — tidak dibutuhkan lagi (lihat bagian 0). Fitur ini reuse `USERBOT_API_ID` / `USERBOT_API_HASH` / `USERBOT_SESSION` yang sudah ada untuk fitur Buy Gift.

## 5. Rumus Harga (final)

```
modalUsd  = stars × STARS_TO_USD_RATE   (kurs sama dipakai fitur Gift, bisa di-override lewat db.settings.starsPricing)
hargaJual = modalUsd × (1 + STARS_MARKUP_PCT / 100)
```

Markup (`STARS_MARKUP_PCT`) independen dari `GIFT_MARKUP_PCT`, sesuai permintaan awal — disimpan terpisah di `db.settings.starsPricing` (bukan `db.settings.giftPricing`), walau modal & mekanisme pengirimannya kini sama-sama dari saldo Stars userbot.

## 6. Keamanan & Edge Case (final)

- ~~Seed phrase HANYA di `.env` server sendiri~~ → **tidak berlaku**, tidak ada wallet TON/seed phrase di fitur ini
- **Cek saldo Stars userbot** dilakukan sebelum eksekusi (`getUserbotStarsBalance()`) — kalau kurang, order ditolak dengan pesan jelas + saldo user tidak dipotong
- **Race condition saldo user**: double-tap tombol konfirmasi dicegah lewat `Set` in-memory `pendingOrderConfirms` per `chatId` (pola yang sama persis dipakai order produk biasa & Buy Gift) — mencegah 2 eksekusi order berjalan bersamaan untuk user yang sama
- ~~Timeout polling status tx on-chain~~ → **tidak relevan**, `payments.SendStarsForm` bersifat sinkron (hasil langsung didapat dari response, tanpa polling)
- **Idempotency**: kalau bot restart tepat saat sebuah order `pending` sedang diproses (antara potong saldo & hasil `sendStarsGiftToUser` diketahui), order itu tidak otomatis di-resume — ini **keterbatasan yang diwariskan dari pola Buy Gift yang sudah ada** (bukan regresi baru dari fitur ini). Mitigasi: admin bisa cek `starsOrders` berstatus `pending` lewat DB secara manual pasca-restart. Kalau dibutuhkan auto-resume, ini perlu ditambahkan sebagai peningkatan terpisah untuk KEDUA fitur (Gift & Stars) sekaligus, karena keduanya berbagi pola yang sama.
- **Validasi input**: jumlah Stars divalidasi terhadap `STARS_GIFT_MIN`/`STARS_GIFT_MAX` sebelum lanjut ke tahap target; format username/ID divalidasi (minimal 3 karakter) sebelum lanjut ke tahap harga

## 7. Acceptance Criteria

- [x] User bisa selesaikan alur end-to-end dan menerima Stars di akun tujuan
- [x] Saldo user terpotong hanya sekali per order sukses (dijaga lock `pendingOrderConfirms`)
- [x] Order gagal → saldo user balik penuh otomatis, tanpa aksi manual
- [x] Admin menerima notifikasi lengkap untuk setiap order (sukses & gagal)
- [x] Order tidak bisa dieksekusi kalau saldo Stars toko (userbot) tidak cukup — saldo user tidak dipotong
- [x] Riwayat order tersimpan di DB (`starsOrders`) dan bisa di-query per user (`getStarsOrdersByUser`) / order ID

## 8. Yang Dibutuhkan dari Owner

~~Alamat wallet TON, seed phrase, akses Fragment.com KYC~~ → **tidak dibutuhkan lagi**. Prasyarat satu-satunya: akun userbot GramJS (`USERBOT_API_ID`/`USERBOT_API_HASH`/`USERBOT_SESSION`) sudah dikonfigurasi dan **punya saldo Stars yang cukup** (top up manual lewat Settings → Stars di aplikasi Telegram akun tersebut) — persis prasyarat yang sudah berlaku untuk fitur Buy Gift saat ini.
