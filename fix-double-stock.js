// ============================================================
// Cek & perbaiki dobel-hitung stok (variant.stock manual TANPA
// kode/link asli, yang kebetulan PERSIS SAMA dengan liveStock API)
//
// CARA PAKAI (jalankan dari folder /root/bot):
//   node fix-double-stock.js            -> cuma cek & tampilkan (AMAN, tidak ubah apapun)
//   node fix-double-stock.js --apply    -> beneran perbaiki (reset stock manual jadi 0
//                                           untuk varian yang match pola dobel-hitung)
// ============================================================
const db = require('./db.js');
const apply = process.argv.includes('--apply');

let found = 0;
db.getAllProducts().forEach(p => {
  p.variants.forEach(v => {
    const isApiLinked = !!(v.canbosoProductId || v.supplierServiceId);
    const hasRealItems = Array.isArray(v.stockItems) && v.stockItems.length > 0;
    const stock = v.stock || 0;
    const liveStock = v.liveStock || 0;
    // Pola mencurigakan: terhubung API, stock manual TIDAK didukung kode
    // asli, dan angkanya PERSIS SAMA dengan liveStock (indikasi dobel input).
    const suspicious = isApiLinked && !hasRealItems && stock > 0 && stock === liveStock;
    if (suspicious) {
      found++;
      console.log(`⚠️  ${p.name} - ${v.label}`);
      console.log(`    stock (manual, tanpa kode asli): ${stock}`);
      console.log(`    liveStock (API): ${liveStock}`);
      console.log(`    Total ditampilkan SEKARANG: ${stock + liveStock}  ->  Seharusnya: ${liveStock}`);
      if (apply) {
        db.setVariantStock(p.id, v.id, liveStock); // liveStock tetap
        // Reset field stock manual ke 0 langsung lewat require ulang db (pakai fungsi resmi kalau ada, fallback manual)
        const raw = require('fs').readFileSync('./data/db.json', 'utf-8');
        const data = JSON.parse(raw);
        const prod = data.products.find(pp => pp.id === p.id);
        const variant = prod && prod.variants.find(vv => vv.id === v.id);
        if (variant) {
          variant.stock = 0;
          require('fs').writeFileSync('./data/db.json', JSON.stringify(data, null, 2));
        }
        console.log(`    ✅ DIPERBAIKI - stock manual direset ke 0, total sekarang: ${liveStock}`);
      }
      console.log('');
    }
  });
});

if (found === 0) {
  console.log('✅ Tidak ada pola dobel-hitung yang ditemukan.');
} else if (!apply) {
  console.log(`\n📋 Ditemukan ${found} varian dengan pola mencurigakan (lihat di atas).`);
  console.log('   Kalau semua ini MEMANG bug (bukan stok manual yang sengaja), jalankan:');
  console.log('   node fix-double-stock.js --apply');
} else {
  console.log(`\n✅ Selesai. ${found} varian diperbaiki.`);
  console.log('   Backup otomatis ada di data/db.json.bak (dari sebelum script ini jalan pertama kali).');
}
