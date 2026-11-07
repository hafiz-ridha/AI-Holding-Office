// Business directory & business detail: profile, logo, team, knowledge base, finance, reports, activity.
// Every sub-resource is addressed under /api/businesses/:id/... and filtered by that business id.
import fs from 'node:fs';
import { q } from '../db/index.js';
import {
  listBusinesses, getBusiness, createBusiness, updateBusiness, deleteBusiness, toPublic, saveLogo, logoFile, removeLogo,
} from '../holding/businesses.js';
import { listDocuments, getDocument, createDocument, updateDocument, deleteDocument, setDocumentShares, searchKnowledge } from '../holding/documents.js';
import { listRecords, addRecord, deleteRecord, importCsv, summary, monthRange } from '../holding/finance.js';
import { listReports } from '../holding/reports.js';
import { listEmployees } from '../agents/employees.js';
import { getSetting } from '../lib/settings.js';
import { localDate } from '../lib/time.js';
import { auditReq } from '../lib/audit.js';
import { idParam, body, str, nullableInt, idList, httpError } from './schemas.js';

const fields = {
  name: str(80, 1),
  slug: str(40),
  industry: str(80),
  description: str(4000),
  color: str(7),
  status: { type: 'string', enum: ['active', 'inactive'] },
  manager_employee_id: nullableInt,
  employee_ids: idList,
  extra_access: idList,
};
const sub = (extra = {}) => ({
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 }, ...extra },
});
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };

function mustGet(id) {
  const b = getBusiness(id);
  if (!b) throw httpError('Bisnis tidak ditemukan', 404);
  return b;
}

export default async function businessRoutes(app) {
  app.get('/api/businesses', {
    schema: { querystring: { type: 'object', properties: { status: { type: 'string', enum: ['active', 'inactive'] } } } },
  }, async (req) => listBusinesses({ status: req.query.status || null }));

  app.post('/api/businesses', { schema: { body: body(fields, ['name']) } }, async (req, reply) => {
    const b = createBusiness(req.body);
    auditReq(req, 'business_created', b.slug, null, b.id);
    return reply.code(201).send(b);
  });

  app.get('/api/businesses/:id', { schema: { params: idParam } }, async (req) => {
    const b = mustGet(req.params.id);
    const tz = getSetting('timezone');
    const [from, to] = monthRange(localDate(Date.now(), tz));
    return {
      business: toPublic(b),
      team: listEmployees({ businessId: b.id }),
      finance_month: summary(b.id, from, to),
      approvals_pending: q.get("SELECT COUNT(*) n FROM approvals WHERE business_id = ? AND status = 'pending'", b.id).n,
    };
  });

  app.put('/api/businesses/:id', { schema: { params: idParam, body: body(fields) } }, async (req) => {
    const b = updateBusiness(req.params.id, req.body);
    auditReq(req, 'business_updated', b.slug, { fields: Object.keys(req.body) }, b.id);
    return b;
  });

  app.delete('/api/businesses/:id', { schema: { params: idParam } }, async (req) => {
    const b = mustGet(req.params.id);
    deleteBusiness(b.id);
    auditReq(req, 'business_deleted', b.slug);
    return { ok: true };
  });

  // ---- logo ----
  app.post('/api/businesses/:id/logo', {
    bodyLimit: 512 * 1024,
    schema: { params: idParam, body: body({ data_url: str(450000, 20) }, ['data_url']) },
  }, async (req) => {
    const b = saveLogo(req.params.id, req.body.data_url);
    auditReq(req, 'business_logo_updated', b.slug, null, b.id);
    return b;
  });

  app.delete('/api/businesses/:id/logo', { schema: { params: idParam } }, async (req) => removeLogo(req.params.id));

  app.get('/api/businesses/:id/logo', { schema: { params: idParam } }, async (req, reply) => {
    const f = logoFile(req.params.id);
    if (!f) throw httpError('Logo tidak ada', 404);
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.header('Content-Security-Policy', "default-src 'none'");
    return reply.type(f.type).send(fs.createReadStream(f.file));
  });

  // ---- knowledge base & documents ----
  app.get('/api/businesses/:id/documents', { schema: { params: idParam } }, async (req) => {
    mustGet(req.params.id);
    return listDocuments(req.params.id);
  });

  app.get('/api/businesses/:id/documents/:docId', { schema: { params: sub({ docId: { type: 'integer' } }) } }, async (req) => {
    const d = getDocument(req.params.docId, req.params.id);
    if (!d) throw httpError('Dokumen tidak ditemukan di bisnis ini', 404);
    return d;
  });

  app.post('/api/businesses/:id/documents', {
    bodyLimit: 512 * 1024,
    schema: {
      params: idParam,
      body: body({ title: str(200, 1), content: str(210000, 1), kind: { type: 'string', enum: ['knowledge', 'document'] }, filename: str(200), mime: str(60) }, ['title', 'content']),
    },
  }, async (req, reply) => {
    mustGet(req.params.id);
    const d = createDocument(req.params.id, req.body, `owner:${req.user.username}`);
    auditReq(req, 'document_created', `doc:${d.id}`, { title: d.title }, req.params.id);
    return reply.code(201).send({ id: d.id, title: d.title, size: d.size });
  });

  app.put('/api/businesses/:id/documents/:docId', {
    bodyLimit: 512 * 1024,
    schema: { params: sub({ docId: { type: 'integer' } }), body: body({ title: str(200, 1), content: str(210000, 1) }) },
  }, async (req) => {
    const d = updateDocument(req.params.docId, req.params.id, req.body);
    auditReq(req, 'document_updated', `doc:${d.id}`, null, req.params.id);
    return { id: d.id, title: d.title, size: d.size };
  });

  app.delete('/api/businesses/:id/documents/:docId', { schema: { params: sub({ docId: { type: 'integer' } }) } }, async (req) => {
    deleteDocument(req.params.docId, req.params.id);
    auditReq(req, 'document_deleted', `doc:${req.params.docId}`, null, req.params.id);
    return { ok: true };
  });

  app.put('/api/businesses/:id/documents/:docId/shares', {
    schema: { params: sub({ docId: { type: 'integer' } }), body: body({ business_ids: idList }, ['business_ids']) },
  }, async (req) => {
    const shared = setDocumentShares(req.params.docId, req.params.id, req.body.business_ids);
    auditReq(req, 'document_shared', `doc:${req.params.docId}`, { with: shared }, req.params.id);
    return { shared_with: shared };
  });

  app.get('/api/businesses/:id/knowledge/search', {
    schema: { params: idParam, querystring: { type: 'object', required: ['q'], properties: { q: str(200, 1) } } },
  }, async (req) => {
    mustGet(req.params.id);
    return searchKnowledge(req.params.id, req.query.q, { limit: 5, maxChars: 3000 });
  });

  // ---- finance ----
  app.get('/api/businesses/:id/finance', {
    schema: { params: idParam, querystring: { type: 'object', properties: { from: DATE, to: DATE } } },
  }, async (req) => {
    mustGet(req.params.id);
    const tz = getSetting('timezone');
    const [mFrom, mTo] = monthRange(localDate(Date.now(), tz));
    const from = req.query.from || mFrom;
    const to = req.query.to || mTo;
    return { from, to, summary: summary(req.params.id, from, to), records: listRecords(req.params.id, { from, to }) };
  });

  app.post('/api/businesses/:id/finance', {
    schema: {
      params: idParam,
      body: body({
        record_date: DATE, type: { type: 'string', enum: ['income', 'expense'] }, category: str(80),
        amount: { type: 'number', minimum: 0 }, currency: str(3), description: str(500),
      }, ['record_date', 'type', 'amount']),
    },
  }, async (req, reply) => {
    const r = addRecord(req.params.id, req.body, `owner:${req.user.username}`);
    auditReq(req, 'finance_record_added', `fin:${r.id}`, { type: r.type, amount: r.amount }, req.params.id);
    return reply.code(201).send(r);
  });

  app.post('/api/businesses/:id/finance/import', {
    bodyLimit: 512 * 1024,
    schema: { params: idParam, body: body({ csv: str(400000, 1) }, ['csv']) },
  }, async (req) => {
    const r = importCsv(req.params.id, req.body.csv, `owner:${req.user.username}`);
    auditReq(req, 'finance_imported', null, r, req.params.id);
    return r;
  });

  app.delete('/api/businesses/:id/finance/:recordId', { schema: { params: sub({ recordId: { type: 'integer' } }) } }, async (req) => {
    deleteRecord(req.params.id, req.params.recordId);
    auditReq(req, 'finance_record_deleted', `fin:${req.params.recordId}`, null, req.params.id);
    return { ok: true };
  });

  // ---- reports & activity ----
  app.get('/api/businesses/:id/reports', { schema: { params: idParam } }, async (req) => {
    mustGet(req.params.id);
    return listReports({ businessId: req.params.id });
  });

  app.get('/api/businesses/:id/activity', { schema: { params: idParam } }, async (req) => {
    mustGet(req.params.id);
    return q.all(
      `SELECT l.task_id, l.level, l.event, l.message, l.created_at, t.title FROM task_logs l JOIN tasks t ON t.id = l.task_id
       WHERE l.business_id = ? ORDER BY l.id DESC LIMIT 100`,
      req.params.id
    );
  });
}
