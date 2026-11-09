// Test-only Telegram Bot API stand-in (TELEGRAM_API_BASE points here during tests).
import http from 'node:http';

export async function startMockTelegram({ token = '123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-ra', failSend = false } = {}) {
  const sent = [];
  const updates = [];
  // unknownChats: chat ids the bot cannot reach ("chat not found"); migrate: { from, to } group -> supergroup.
  const state = { failSend, unknownChats: new Set(), migrate: null };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const data = body ? JSON.parse(body) : {};
    const ok = (result) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    };
    const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
    if (!m || m[1] !== token) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }));
    }
    switch (m[2]) {
      case 'getMe':
        return ok({ id: 123456789, is_bot: true, username: 'holding_test_bot' });
      case 'getChat': {
        const id = String(data.chat_id);
        if (state.unknownChats.has(id)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }));
        }
        return ok(id.startsWith('-') ? { id: Number(id), type: 'supergroup', title: 'Grup Holding' } : { id: Number(id), type: 'private', first_name: 'Owner', username: 'owner_holding' });
      }
      case 'sendMessage':
        if (state.migrate && String(data.chat_id) === String(state.migrate.from)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: state.migrate.to } }));
        }
        if (state.unknownChats.has(String(data.chat_id))) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }));
        }
        if (state.failSend) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }));
        }
        sent.push(data);
        return ok({ message_id: sent.length });
      case 'getUpdates': {
        const out = updates.filter((u) => u.update_id >= (data.offset || 0));
        if (!out.length) await new Promise((r) => setTimeout(r, 100));
        return ok(out);
      }
      default:
        return ok(true);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    token,
    sent,
    updates,
    state,
    close: () => new Promise((r) => server.close(r)),
  };
}
