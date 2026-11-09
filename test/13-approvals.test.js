// Owner approvals: single decision, bulk decision (one transaction, stale items skipped, audit per item),
// business filter, and input validation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupEnv, buildTestApp, login } from './helpers.js';

let app, s, q;
let bizA, bizB;

function addApproval(businessId, detail) {
  const r = q.run(
    "INSERT INTO approvals(task_id, business_id, title, detail, status, created_at) VALUES (NULL, ?, 'Tugas uji', ?, 'pending', ?)",
    businessId, detail, Date.now()
  );
  return Number(r.lastInsertRowid);
}
const row = (id) => q.get('SELECT * FROM approvals WHERE id = ?', id);

before(async () => {
  await setupEnv();
  ({ q } = await import('../src/db/index.js'));
  app = await buildTestApp();
  s = await login(app);
  [bizA, bizB] = q.all('SELECT id FROM businesses ORDER BY id LIMIT 2').map((b) => b.id);
  assert.ok(bizA && bizB, 'seed has at least two businesses');
});
after(async () => {
  await app?.close();
});

test('single decision is recorded once; deciding the same item again is refused', async () => {
  const id = addApproval(bizA, 'Transfer dana promosi Rp 5.000.000');
  const r = await s.post(`/api/approvals/${id}/decide`, { decision: 'approved', note: 'oke' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(row(id).status, 'approved');
  const again = await s.post(`/api/approvals/${id}/decide`, { decision: 'rejected' });
  assert.equal(again.statusCode, 404);
  assert.equal(row(id).status, 'approved');
});

test('bulk decision: pending items decided together with one note; decided/missing/duplicate ids are skipped', async () => {
  const a = addApproval(bizA, 'Kontrak supplier baru');
  const b = addApproval(bizA, 'Diskon 30% akhir pekan');
  const c = addApproval(null, 'Rekrut dua staf pusat');
  const done = addApproval(bizB, 'Sudah diputuskan sebelumnya');
  q.run("UPDATE approvals SET status = 'rejected', decided_by = 'admin', decided_at = ? WHERE id = ?", Date.now(), done);
  const auditBefore = q.get("SELECT COUNT(*) n FROM audit_logs WHERE action = 'approval_approved'").n;

  const r = await s.post('/api/approvals/decide', { ids: [a, b, c, done, 999999, a], decision: 'approved', note: 'Disetujui bersama' });
  assert.equal(r.statusCode, 200, r.body);
  const out = r.json();
  assert.deepEqual(out.decided.map((x) => x.id).sort(), [a, b, c].sort());
  assert.deepEqual(out.skipped, [{ id: done, reason: 'sudah ditolak' }, { id: 999999, reason: 'tidak ditemukan' }]);
  for (const id of [a, b, c]) {
    const x = row(id);
    assert.equal(x.status, 'approved');
    assert.equal(x.decided_by, 'admin');
    assert.equal(x.decision_note, 'Disetujui bersama');
  }
  assert.equal(row(done).status, 'rejected', 'an earlier decision is never overwritten');

  // One audit entry per decided item, marked as part of a bulk action.
  const audits = q.all("SELECT target, detail, business_id FROM audit_logs WHERE action = 'approval_approved' ORDER BY id DESC LIMIT 3");
  assert.equal(q.get("SELECT COUNT(*) n FROM audit_logs WHERE action = 'approval_approved'").n - auditBefore, 3);
  assert.deepEqual(audits.map((x) => x.target).sort(), [a, b, c].map((id) => `approval:${id}`).sort());
  assert.ok(audits.every((x) => JSON.parse(x.detail).bulk === 3));
  assert.ok(audits.some((x) => x.business_id === null) && audits.some((x) => x.business_id === bizA));
});

test('bulk reject after a stale selection only touches what is still pending', async () => {
  const x = addApproval(bizB, 'Sewa gudang tambahan');
  const y = addApproval(bizB, 'Ganti vendor kemasan');
  await s.post(`/api/approvals/${x}/decide`, { decision: 'approved' }); // decided in another tab meanwhile
  const r = await s.post('/api/approvals/decide', { ids: [x, y], decision: 'rejected' });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().decided.map((d) => d.id), [y]);
  assert.deepEqual(r.json().skipped, [{ id: x, reason: 'sudah disetujui' }]);
  assert.equal(row(x).status, 'approved');
  assert.equal(row(y).status, 'rejected');
});

test('list can be filtered by business (or holding level) together with status', async () => {
  const pa = addApproval(bizA, 'Filter A');
  const ph = addApproval(null, 'Filter holding');
  const onlyA = (await s.get(`/api/approvals?status=pending&business=${bizA}`)).json();
  assert.ok(onlyA.length && onlyA.every((x) => x.business_id === bizA && x.status === 'pending'));
  assert.ok(onlyA.some((x) => x.id === pa));
  const hq = (await s.get('/api/approvals?business=hq')).json();
  assert.ok(hq.length && hq.every((x) => x.business_id === null));
  assert.ok(hq.some((x) => x.id === ph));
  const all = (await s.get('/api/approvals')).json();
  assert.ok(all.some((x) => x.id === pa) && all.some((x) => x.id === ph));
  assert.equal((await s.get('/api/approvals?business=abc')).statusCode, 400);
});

test('bulk input is validated: ids required (1-100 integers), decision must be approved or rejected', async () => {
  const id = addApproval(bizA, 'Validasi');
  for (const payload of [
    { ids: [], decision: 'approved' },
    { ids: [id], decision: 'maybe' },
    { ids: ['x'], decision: 'approved' },
    { ids: Array.from({ length: 101 }, (_, i) => i + 1), decision: 'approved' },
    { decision: 'approved' },
  ]) {
    const r = await s.post('/api/approvals/decide', payload);
    assert.equal(r.statusCode, 400, JSON.stringify(payload).slice(0, 80));
  }
  assert.equal(row(id).status, 'pending');
});
