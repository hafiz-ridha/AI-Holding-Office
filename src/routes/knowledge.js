// Second Brain API: browse/search knowledge notes, write facts, pin, correct or delete notes.
import { listNotes, getNote, createFact, updateNote, deleteNote, knowledgeStats } from '../holding/knowledge.js';
import { getBusiness } from '../holding/businesses.js';
import { auditReq } from '../lib/audit.js';
import { idParam, body, str, bool, intRange, httpError } from './schemas.js';

// scope: 'all' (every note) | 'hq' (holding level) | business id
function parseScope(v, { allowAll = true } = {}) {
  if (v === undefined || v === null || v === '' || v === 'all') {
    if (!allowAll) throw httpError('Pilih holding atau satu bisnis');
    return undefined;
  }
  if (v === 'hq') return null;
  const id = Number(v);
  if (!Number.isInteger(id) || id < 1 || !getBusiness(id)) throw httpError('Bisnis tidak ditemukan', 404);
  return id;
}
const scopePattern = { type: 'string', pattern: '^(all|hq|\\d+)$' };

export default async function knowledgeRoutes(app) {
  app.get('/api/knowledge', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          scope: scopePattern,
          q: str(200),
          kind: { type: 'string', enum: ['work', 'fact'] },
          pinned: bool,
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          offset: { type: 'integer', minimum: 0, default: 0 },
        },
      },
    },
  }, async (req) => {
    const r = listNotes({
      scope: parseScope(req.query.scope), search: req.query.q || '', kind: req.query.kind || null,
      pinned: req.query.pinned ?? null, limit: req.query.limit, offset: req.query.offset,
    });
    return { ...r, stats: knowledgeStats() };
  });

  app.get('/api/knowledge/:id', { schema: { params: idParam } }, async (req) => {
    const n = getNote(req.params.id);
    if (!n) throw httpError('Catatan tidak ditemukan', 404);
    return n;
  });

  app.post('/api/knowledge', {
    schema: { body: body({ scope: scopePattern, title: str(200, 1), content: str(4000, 1), pinned: bool }, ['scope', 'title', 'content']) },
  }, async (req, reply) => {
    const scope = parseScope(req.body.scope, { allowAll: false });
    const n = createFact({ scope, title: req.body.title, content: req.body.content, pinned: req.body.pinned ?? true, author: req.user.username });
    auditReq(req, 'knowledge_fact_created', `K-${n.id}`, { title: n.title }, scope ?? null);
    return reply.code(201).send(n);
  });

  app.put('/api/knowledge/:id', {
    schema: { params: idParam, body: body({ title: str(200, 1), content: str(4000, 1), pinned: bool, importance: intRange(1, 3) }) },
  }, async (req) => {
    const n = updateNote(req.params.id, req.body);
    auditReq(req, 'knowledge_updated', `K-${n.id}`, { fields: Object.keys(req.body) }, n.business_id ?? null);
    return n;
  });

  app.delete('/api/knowledge/:id', { schema: { params: idParam } }, async (req) => {
    const n = deleteNote(req.params.id);
    auditReq(req, 'knowledge_deleted', `K-${n.id}`, { title: n.title }, n.business_id ?? null);
    return { deleted: true };
  });
}
