import { listMessages, sendOwnerMessage, typingIn, clearMessages } from '../holding/chat.js';
import { getBusiness } from '../holding/businesses.js';
import { auditReq } from '../lib/audit.js';
import { body, str, nullableInt, httpError } from './schemas.js';

// channel: 'all' (every channel, holding view) | 'hq' (holding channel only) | business id
function parseChannel(v) {
  if (v === undefined || v === null || v === '' || v === 'all') return undefined;
  if (v === 'hq') return null;
  const id = Number(v);
  if (!Number.isInteger(id) || id < 1) throw httpError('Channel tidak valid');
  if (!getBusiness(id)) throw httpError('Bisnis tidak ditemukan', 404);
  return id;
}

const channelQuery = { type: 'string', pattern: '^(all|hq|\\d+)$' };

export default async function chatRoutes(app) {
  app.get('/api/chat', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          channel: channelQuery,
          after: { type: 'integer', minimum: 0 },
          before: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 60 },
        },
      },
    },
  }, async (req) => {
    const businessId = parseChannel(req.query.channel);
    return {
      messages: listMessages({ businessId, after: req.query.after || 0, before: req.query.before || null, limit: req.query.limit }),
      typing: typingIn(businessId),
    };
  });

  app.post('/api/chat', {
    schema: {
      body: body(
        {
          channel: { type: 'string', pattern: '^(hq|\\d+)$' },
          content: str(4000, 1),
          recipient_employee_id: nullableInt,
          mode: { type: 'string', enum: ['reply', 'task', 'note'] },
        },
        ['channel', 'content']
      ),
    },
  }, async (req, reply) => {
    const businessId = parseChannel(req.body.channel);
    const r = sendOwnerMessage({
      businessId,
      content: req.body.content,
      recipientEmployeeId: req.body.recipient_employee_id ?? null,
      mode: req.body.mode || 'reply',
      ownerName: req.user.username,
    });
    if (r.task) auditReq(req, 'chat_task_created', r.task.code, { mode: req.body.mode || 'reply' }, businessId ?? null);
    return reply.code(201).send(r);
  });

  app.delete('/api/chat', {
    schema: { querystring: { type: 'object', required: ['channel'], properties: { channel: channelQuery } } },
  }, async (req) => {
    const businessId = parseChannel(req.query.channel);
    const n = clearMessages(businessId);
    auditReq(req, 'chat_cleared', req.query.channel, { deleted: n }, businessId ?? null);
    return { deleted: n };
  });
}
