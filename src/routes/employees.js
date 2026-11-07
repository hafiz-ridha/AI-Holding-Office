import {
  listEmployees, getEmployee, createEmployee, updateEmployee, deleteEmployee, toPublic,
  listMemories, clearMemories, deleteMemory, ROLE_KEYS, ORG_UNITS,
} from '../agents/employees.js';
import { auditReq } from '../lib/audit.js';
import { idParam, body, str, nullableInt, bool, idList, httpError } from './schemas.js';

const avatar = {
  type: 'object',
  additionalProperties: false,
  properties: {
    skin: str(7), hair: str(7), shirt: str(7), pants: str(7), accent: str(7),
    hairStyle: str(10), glasses: { type: 'boolean' },
  },
};

const fields = {
  name: str(60, 1),
  role: str(80, 1),
  role_key: { type: 'string', enum: ROLE_KEYS },
  org_unit: { type: 'string', enum: ORG_UNITS },
  personality: str(1000),
  system_prompt: str(8000),
  avatar,
  provider_id: nullableInt,
  model: { type: ['string', 'null'], maxLength: 200 },
  temperature: { type: 'number', minimum: 0, maximum: 2 },
  max_tokens: { type: 'integer', minimum: 0, maximum: 32000 },
  enabled: bool,
  business_ids: idList,
};

export default async function employeeRoutes(app) {
  app.get('/api/employees', {
    schema: { querystring: { type: 'object', properties: { org_unit: { type: 'string', enum: ORG_UNITS }, business_id: { type: 'integer' } } } },
  }, async (req) => listEmployees({ orgUnit: req.query.org_unit || null, businessId: req.query.business_id || null }));

  app.get('/api/employees/:id', { schema: { params: idParam } }, async (req) => {
    const e = getEmployee(req.params.id);
    if (!e) throw httpError('Karyawan tidak ditemukan', 404);
    return toPublic(e);
  });

  app.post('/api/employees', { schema: { body: body(fields, ['name', 'role']) } }, async (req, reply) => {
    const e = createEmployee(req.body);
    auditReq(req, 'employee_created', e.slug);
    return reply.code(201).send(e);
  });

  app.put('/api/employees/:id', { schema: { params: idParam, body: body(fields) } }, async (req) => {
    const e = updateEmployee(req.params.id, req.body);
    auditReq(req, 'employee_updated', e.slug, { fields: Object.keys(req.body) });
    return e;
  });

  app.delete('/api/employees/:id', { schema: { params: idParam } }, async (req) => {
    const e = getEmployee(req.params.id);
    deleteEmployee(req.params.id);
    auditReq(req, 'employee_deleted', e?.slug);
    return { ok: true };
  });

  app.get('/api/employees/:id/memories', { schema: { params: idParam } }, async (req) => listMemories(req.params.id, 100));

  app.delete('/api/employees/:id/memories', { schema: { params: idParam } }, async (req) => {
    const n = clearMemories(req.params.id);
    auditReq(req, 'memories_cleared', `employee:${req.params.id}`, { count: n });
    return { deleted: n };
  });

  app.delete('/api/employees/:id/memories/:memoryId', {
    schema: { params: { type: 'object', properties: { id: { type: 'integer' }, memoryId: { type: 'integer' } } } },
  }, async (req) => ({ deleted: deleteMemory(req.params.id, req.params.memoryId) }));
}
