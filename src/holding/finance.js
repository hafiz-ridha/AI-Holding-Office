// Financial records: every row belongs to exactly one business. Summaries never mix businesses.
import { q, now, tx } from '../db/index.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function httpError(msg, code = 400) {
  const e = new Error(msg);
  e.statusCode = code;
  return e;
}

function clean(r) {
  if (!DATE.test(r.record_date || '')) throw httpError('Tanggal harus format YYYY-MM-DD');
  if (!['income', 'expense'].includes(r.type)) throw httpError('Tipe harus income atau expense');
  const amount = Number(r.amount);
  if (!Number.isFinite(amount) || amount < 0) throw httpError('Jumlah harus angka ≥ 0');
  const currency = String(r.currency || 'IDR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw httpError('Mata uang harus kode 3 huruf (IDR, USD, ...)');
  return {
    record_date: r.record_date,
    type: r.type,
    category: String(r.category || '').slice(0, 80),
    amount,
    currency,
    description: String(r.description || '').slice(0, 500),
  };
}

export function listRecords(businessId, { from = null, to = null, limit = 200 } = {}) {
  return q.all(
    `SELECT * FROM financial_records WHERE business_id = ? AND (? IS NULL OR record_date >= ?) AND (? IS NULL OR record_date <= ?)
     ORDER BY record_date DESC, id DESC LIMIT ?`,
    businessId, from, from, to, to, limit
  );
}

export function addRecord(businessId, data, by = 'owner') {
  if (!q.get('SELECT id FROM businesses WHERE id = ?', businessId)) throw httpError('Bisnis tidak ditemukan', 404);
  const r = clean(data);
  const t = now();
  const res = q.run(
    `INSERT INTO financial_records(business_id, record_date, type, category, amount, currency, description, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    businessId, r.record_date, r.type, r.category, r.amount, r.currency, r.description, by, t, t
  );
  return q.get('SELECT * FROM financial_records WHERE id = ?', res.lastInsertRowid);
}

export function deleteRecord(businessId, id) {
  const r = q.run('DELETE FROM financial_records WHERE id = ? AND business_id = ?', id, businessId);
  if (!r.changes) throw httpError('Catatan tidak ditemukan di bisnis ini', 404);
  return true;
}

// CSV columns: date,type,category,amount,currency,description (header row optional).
export function importCsv(businessId, csv, by = 'owner') {
  const lines = String(csv || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 2000) throw httpError('Maksimal 2000 baris per impor');
  const rows = [];
  const errors = [];
  lines.forEach((line, i) => {
    const cols = line.split(/[;,](?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.replace(/^"|"$/g, '').trim());
    if (i === 0 && /date|tanggal/i.test(cols[0])) return;
    try {
      rows.push(clean({ record_date: cols[0], type: cols[1], category: cols[2], amount: cols[3], currency: cols[4] || 'IDR', description: cols[5] }));
    } catch (e) {
      errors.push(`Baris ${i + 1}: ${e.message}`);
    }
  });
  if (errors.length) throw httpError(errors.slice(0, 5).join('; '));
  tx(() => {
    for (const r of rows) addRecord(businessId, r, by);
  });
  return { imported: rows.length };
}

// Summary per currency for one business and period. Returns null when no data exists.
export function summary(businessId, from, to) {
  const rows = q.all(
    `SELECT currency, type, SUM(amount) AS total, COUNT(*) AS n FROM financial_records
     WHERE business_id = ? AND record_date >= ? AND record_date <= ? GROUP BY currency, type`,
    businessId, from, to
  );
  if (!rows.length) return null;
  const byCurrency = {};
  for (const r of rows) {
    const c = (byCurrency[r.currency] ||= { currency: r.currency, income: 0, expense: 0, net: 0, records: 0 });
    c[r.type] = r.total;
    c.records += r.n;
  }
  for (const c of Object.values(byCurrency)) c.net = c.income - c.expense;
  const topExpenses = q.all(
    `SELECT category, currency, SUM(amount) AS total FROM financial_records
     WHERE business_id = ? AND type = 'expense' AND record_date >= ? AND record_date <= ?
     GROUP BY category, currency ORDER BY total DESC LIMIT 5`,
    businessId, from, to
  );
  return { from, to, currencies: Object.values(byCurrency), topExpenses };
}

export function monthRange(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${y}-${String(m).padStart(2, '0')}-01`, `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`];
}

export function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency, maximumFractionDigits: currency === 'IDR' ? 0 : 2 }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export function summaryText(s) {
  if (!s) return 'belum ada catatan keuangan di sistem untuk periode ini';
  const lines = s.currencies.map(
    (c) => `- ${c.currency}: pemasukan ${formatMoney(c.income, c.currency)}, pengeluaran ${formatMoney(c.expense, c.currency)}, bersih ${formatMoney(c.net, c.currency)} (${c.records} catatan)`
  );
  if (s.topExpenses.length) {
    lines.push('- Pengeluaran terbesar: ' + s.topExpenses.map((e) => `${e.category || 'lainnya'} ${formatMoney(e.total, e.currency)}`).join(', '));
  }
  return `Periode ${s.from} s/d ${s.to}\n${lines.join('\n')}`;
}
