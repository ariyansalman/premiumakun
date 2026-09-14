// ============================================================
// AUTO BACKUP — zip full source code project (kecuali node_modules, .npm,
// dan file .zip apapun - lihat isZipFile() di bawah)
// ============================================================
// Dipakai oleh bot.js untuk fitur "💾 Auto Backup" di /admin: bikin file
// .zip berisi SEMUA file project (kode, config, data/db.json, dst) TANPA
// folder node_modules & .npm, TANPA `.env` (lihat EXCLUDE_FILES - dikecualikan
// karena berisi token bot/API key), dan TANPA file .zip lain yang
// mungkin nyasar ke folder project — supaya ukuran file kecil (bukan MB
// besar) dan tidak membengkak tiap kali backup jalan.
//
// Pakai package "archiver" (pure JS, ringan, populer) untuk bikin zip-nya.
// Kalau belum ke-install, jalankan: npm install
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const PROJECT_ROOT = __dirname;
// Folder tujuan file .zip sementara sebelum dikirim ke Telegram, lalu
// dihapus lagi lewat cleanupBackupFile() setelah terkirim.
const BACKUP_TMP_DIR = path.join(PROJECT_ROOT, 'backup_tmp');

// Folder yang DIKECUALIKAN dari backup. Sengaja HANYA node_modules & .npm
// sesuai permintaan (biar full source code + data ikut, dan restore-nya
// tinggal `npm install` lagi). .git & backup_tmp turut di-skip supaya tidak
// ikut ke-zip riwayat git yang besar / file zip sebelumnya yang lagi dibuat.
// Folder yang DIKECUALIKAN dari backup. Selain nama persis di
// EXPLICIT_EXCLUDE_DIRS di bawah, folder APAPUN yang namanya diawali
// "backup_" JUGA di-skip otomatis - lihat isJunkBackupDir() (PATCH v7).
const EXPLICIT_EXCLUDE_DIRS = new Set(['node_modules', '.npm', '.git', 'backup_tmp']);

// ===== PATCH v7: exclude folder backup manual apapun namanya =====
// Sebelumnya EXCLUDE_DIRS cuma daftar 4 nama persis di atas - folder backup
// manual yang dibuat admin sebelum operasi berisiko (contoh:
// "backup_manual_sebelum_hapus_stars/", isinya duplikat bot.js/db.js/dst)
// TIDAK PERNAH ke-skip kalau ditaruh di root project - jadi folder itu ikut
// ke-zip TERUS-MENERUS di SETIAP auto-backup berikutnya selama-lamanya
// (bukan cuma sekali), bikin ukuran zip membengkak permanen sebesar isi
// folder itu. Sekarang folder apapun yang namanya diawali "backup_" (selain
// "backup_tmp" yang sudah di-exclude terpisah) otomatis ikut di-skip -
// jadi kebiasaan bikin folder "backup_manual_..." sebelum operasi berisiko
// aman dilakukan lagi ke depannya tanpa bikin ukuran auto-backup membengkak.
function isJunkBackupDir(name) {
  return name.toLowerCase().startsWith('backup_');
}

function isExcludedDir(name) {
  return EXPLICIT_EXCLUDE_DIRS.has(name) || isJunkBackupDir(name);
}

// File apapun berekstensi .zip TIDAK PERNAH ikut di-backup, di folder manapun
// dia berada. Ini penting: kalau file backup lama (hasil download ulang dari
// group Telegram, atau backup manual) sengaja/tidak sengaja ditaruh balik ke
// folder project, backup BERIKUTNYA bakal ikut nge-zip file zip lama itu ke
// dalam zip baru -> ukurannya membesar terus tiap kali backup jalan (bahkan
// bisa "zip di dalam zip di dalam zip" kalau dibiarkan lama). Skip total
// supaya ukuran backup tetap konsisten kecil setiap saat.
function isZipFile(name) {
  return name.toLowerCase().endsWith('.zip');
}

// ===== PATCH v6: exclude file backup/.bak dari ikut ke-zip =====
// Sebelumnya cuma file .zip yang di-skip (lihat isZipFile() di atas).
// Tapi file backup KODE (bot.js.bak, bot.js.bak.<timestamp> dari
// update.sh, data/db.json.bak, data/db.json.before-fix-*) TIDAK ikut
// ke-skip - jadi tiap kali auto-backup jalan, file2 nyampah itu ikut
// kebawa ke dalam zip, dan ukuran backup terus MEMBESAR tiap kali admin
// habis update.sh (nambah 1 bot.js.bak.* baru tiap kali). Sekarang
// pattern *.bak, *.bak.*, dan *.before-fix-* di-skip juga - backup jadi
// selalu berisi source code AKTIF saja, ukurannya konsisten.
//
// ===== PATCH v7: perbaiki bug regex .bak + tambah pola .beforeupdate =====
// Bug lama: regex `/\.bak\.\d+/` cuma nangkep pola TITIK sebelum angka
// (mis. "bot.js.bak.123"), padahal nama file .bak yang BENERAN kepakai di
// VPS ini pola STRIP (mis. "bot.js.bak-1788584382") - jadi lolos terus dari
// filter dan ikut ke-zip. Sekarang regex terima titik ATAUPUN strip
// (`[.\-]`). Ditambah juga pola ".beforeupdate" (mis.
// "data/db.json.beforeupdate") yang belum pernah masuk daftar sebelumnya.
function isJunkBackupFile(name) {
  const n = name.toLowerCase();
  return n.endsWith('.bak')
    || /\.bak[.\-]\d+/.test(n)
    || n.includes('.before-fix-')
    || n.endsWith('.beforeupdate');
}

function isSkippedFile(name) {
  return isZipFile(name) || isJunkBackupFile(name);
}

// File tertentu (nama persis, case-insensitive) yang WAJIB di-skip dari backup
// walau bukan hasil auto-backup bot ini sendiri — misalnya file zip source code
// full project yang sengaja ditaruh admin di folder ini buat keperluan lain,
// tapi tidak boleh ikut kebawa ke dalam backup berikutnya. Tambahkan nama file
// lain di sini kalau ada kasus serupa nanti.
//
// `.env` WAJIB dikecualikan dari auto-backup - berisi token bot, API key
// supplier/payment, dan kredensial lain yang tidak boleh ikut terkirim ke
// BACKUP_GROUP_ID setiap auto-backup jalan. Backup restore tetap bisa jalan
// normal: admin isi ulang .env manual di server baru dari catatan pribadi
// (password manager dsb), BUKAN dari file backup zip yang beredar di Telegram.
const EXCLUDE_FILES = new Set(['premium-akun-bot-update-full.zip', '.env']);
function isExcludedFile(name) {
  return EXCLUDE_FILES.has(name.toLowerCase());
}

function pad(n) { return String(n).padStart(2, '0'); }

function timestampForFilename(date) {
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    '_' + pad(date.getHours()) + '-' + pad(date.getMinutes()) + '-' + pad(date.getSeconds())
  );
}

// Bikin 1 file .zip berisi seluruh project (kecuali EXCLUDE_DIRS di atas).
// Resolve dengan { zipPath, sizeBytes, fileName }.
function createBackupZip() {
  return new Promise((resolve, reject) => {
    try {
      if (!fs.existsSync(BACKUP_TMP_DIR)) fs.mkdirSync(BACKUP_TMP_DIR, { recursive: true });

      const fileName = `backup-${timestampForFilename(new Date())}.zip`;
      const zipPath = path.join(BACKUP_TMP_DIR, fileName);
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => resolve({ zipPath, sizeBytes: archive.pointer(), fileName }));
      archive.on('warning', (err) => {
        if (err.code === 'ENOENT') return; // file hilang di tengah jalan - abaikan, jangan gagalin semuanya
        reject(err);
      });
      archive.on('error', (err) => reject(err));

      archive.pipe(output);

      // Walk manual (bukan archive.glob) supaya folder yang di-exclude tidak
      // usah dibuka/dibaca isinya sama sekali - lebih cepat & pasti aman.
      (function addDir(dirAbs, dirRel) {
        const entries = fs.readdirSync(dirAbs, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && isExcludedDir(entry.name)) continue; // lihat isExcludedDir() di atas
          const absPath = path.join(dirAbs, entry.name);
          const relPath = dirRel ? `${dirRel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            addDir(absPath, relPath);
          } else if (entry.isFile()) {
            if (isSkippedFile(entry.name)) continue; // lihat isZipFile()/isJunkBackupFile() di atas
            if (isExcludedFile(entry.name)) continue; // lihat komentar EXCLUDE_FILES di atas
            archive.file(absPath, { name: relPath });
          }
        }
      })(PROJECT_ROOT, '');

      archive.finalize();
    } catch (err) {
      reject(err);
    }
  });
}

// Hapus file .zip sementara setelah selesai dikirim (best-effort, tidak throw).
function cleanupBackupFile(zipPath) {
  fs.unlink(zipPath, () => {});
}

module.exports = { createBackupZip, cleanupBackupFile, BACKUP_TMP_DIR };
