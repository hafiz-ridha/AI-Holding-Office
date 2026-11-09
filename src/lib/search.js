// Keyword search helpers shared by the knowledge base (documents) and the Second Brain (knowledge notes).
// SQLite FTS5 matches exact tokens, so queries are widened here: Indonesian/English stop words are dropped, words
// get a prefix match ("penjualan" also finds "penjualannya") and common business synonyms are added
// ("omzet" also finds "pendapatan" / "revenue"). No embeddings, no extra dependency.

const STOP = new Set(`
yang dan untuk dengan dari pada ini itu atau ada akan tidak bisa juga dalam oleh agar sudah saya kami kita anda
mereka tolong buat buatkan mohon apa bagaimana berapa kapan mana siapa kenapa mengapa para secara lebih harus perlu
serta karena jika kalau bila sebagai setiap semua hari sini situ dong nya lah kah pun sangat masih belum baru lagi
hal cara agar supaya kepada terhadap antara tentang seperti hanya saja telah sedang dapat boleh mau ingin coba
halo hai hallo selamat pagi siang sore malam kabar terima kasih makasih thanks oke siap mantap baik semoga
tim team hasil kerja tugas judul untukmu kamu kalian bapak ibu kak mas mbak
the and for with from this that are was were have has into your our you they them their what how when where which
who why will would should could can please about than then also just only very more most some any each per via
`.split(/\s+/).filter(Boolean));

// Each group is a set of interchangeable business terms (Indonesian + English).
const GROUPS = [
  ['omzet', 'omset', 'pendapatan', 'penjualan', 'revenue', 'sales', 'penghasilan'],
  ['biaya', 'pengeluaran', 'beban', 'expense', 'cost', 'ongkos'],
  ['laba', 'untung', 'keuntungan', 'profit', 'margin'],
  ['rugi', 'kerugian', 'loss'],
  ['pelanggan', 'customer', 'konsumen', 'klien', 'client', 'pembeli'],
  ['harga', 'price', 'pricing', 'tarif'],
  ['promo', 'promosi', 'diskon', 'discount', 'kampanye', 'campaign'],
  ['iklan', 'ads', 'advertising', 'periklanan'],
  ['karyawan', 'pegawai', 'staf', 'staff', 'sdm', 'personel'],
  ['gaji', 'upah', 'salary', 'payroll'],
  ['stok', 'stock', 'persediaan', 'inventory', 'inventori'],
  ['target', 'sasaran', 'goal', 'kpi'],
  ['strategi', 'strategy', 'rencana', 'roadmap'],
  ['laporan', 'report', 'rekap', 'ringkasan'],
  ['pemasaran', 'marketing'],
  ['keuangan', 'finansial', 'finance', 'financial'],
  ['anggaran', 'budget'],
  ['pemasok', 'supplier', 'vendor'],
  ['produk', 'product', 'barang'],
  ['kompetitor', 'pesaing', 'competitor'],
  ['website', 'situs', 'web'],
  ['media sosial', 'sosmed', 'instagram', 'tiktok', 'social'],
  ['risiko', 'risk', 'resiko'],
  ['pajak', 'tax'],
  ['kontrak', 'perjanjian', 'contract'],
  ['cabang', 'outlet', 'gerai', 'toko'],
];
const SYN = new Map();
for (const g of GROUPS) for (const w of g) if (!w.includes(' ')) SYN.set(w, g.filter((x) => !x.includes(' ')));

/** Normalised, de-duplicated content words of a text (stop words removed). */
export function words(text, max = 24) {
  const out = [];
  for (const w of String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)) {
    if (w.length < 3 || STOP.has(w) || /^\d{1,2}$/.test(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

const term = (w) => (w.length >= 4 && !/\d/.test(w) ? `"${w}"*` : `"${w}"`);

/**
 * FTS5 MATCH expression for free text: OR of every content word, each widened with its synonyms.
 * Returns '' when nothing searchable remains.
 */
export function ftsQuery(text, max = 16) {
  const parts = [];
  for (const w of words(text, max)) {
    const alts = [...new Set([w, ...(SYN.get(w) || [])])];
    parts.push(alts.length > 1 ? `(${alts.map(term).join(' OR ')})` : term(w));
  }
  return parts.join(' OR ');
}

/** Word-overlap similarity (0..1) of two short texts, used to spot a task that was already done before. */
export function similarity(a, b) {
  const A = new Set(words(a, 40));
  const B = new Set(words(b, 40));
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.min(A.size, B.size) * (Math.min(A.size, B.size) / Math.max(A.size, B.size)) ** 0.5;
}
