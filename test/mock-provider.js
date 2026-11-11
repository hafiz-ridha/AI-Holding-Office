// Test-only OpenAI-compatible server. Behaviour is selected by the model name so router logic can be exercised
// without real API keys. Never used by the application itself.
import http from 'node:http';

export async function startMockProvider({ key = 'test-key', delayMs = 0 } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : null;
    calls.push({ method: req.method, url: req.url, body: data });
    // "/nomodels/v1/..." simulates providers that have chat completions but no /models endpoint.
    if (req.url.startsWith('/nomodels/')) {
      req.url = req.url.slice('/nomodels'.length);
      if (req.url === '/v1/models') {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Not Found' } }));
      }
    }
    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    if (key && req.headers.authorization !== `Bearer ${key}`) return send(401, { error: { message: 'Invalid API key', code: 401 } });
    if (req.url === '/v1/key') return send(200, { data: { is_free_tier: true, free_model_daily_requests: { used: 1, limit: 50, remaining: 49 } } });
    if (req.url === '/v1/models') {
      return send(200, {
        data: [
          { id: 'ok-model', name: 'OK', pricing: { prompt: '0.000001', completion: '0.000002' }, context_length: 8192 },
          { id: 'free-model:free', name: 'Free', pricing: { prompt: '0', completion: '0' }, context_length: 32768 },
          { id: 'fail-model', name: 'Fail' },
        ],
      });
    }
    if (req.url === '/v1/chat/completions') {
      const m = data.model;
      const lastUser = [...data.messages].reverse().find((x) => x.role === 'user')?.content || '';
      if (m === 'fail-model' || m.startsWith('fail-')) return send(500, { error: { message: 'upstream exploded' } });
      if (m === 'rate-model') return send(429, { error: { message: 'Rate limit exceeded' } }, { 'retry-after': '30' });
      if (m === 'daily-model') return send(429, { error: { message: 'Rate limit exceeded: free-models-per-day' } });
      if (m === 'missing-model') return send(404, { error: { message: 'No endpoints found for model' } });
      if (m === 'empty-model') return send(200, { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] });
      if (m === 'slow-model') await new Promise((r) => setTimeout(r, 3000));
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      let content = `Hasil kerja untuk: ${lastUser.slice(0, 80)}`;
      if (/APPROVAL_TEST/.test(lastUser)) content += '\n\nPERLU PERSETUJUAN ADMIN: Transfer dana promosi Rp 5.000.000';
      // A full work result, long enough to be kept by the Second Brain.
      if (/HASIL_PANJANG/.test(lastUser)) {
        content += '\n\n## Ringkasan\nTemuan utama: harga pesaing rata-rata Rp28.000 per gelas, promo bundling paling efektif di akhir pekan, ' +
          'pelanggan baru datang dari Instagram.\n\n## Rekomendasi\nUji paket bundling dua minggu dan ukur kenaikan omzet.';
      }
      const slugsIn = (section) => [...section.matchAll(/slug "([^"]+)"/g)].map((m) => m[1]);
      // Group CEO planning prompt -> one business task per listed business + one shared-service task.
      if (/RENCANA_HOLDING_JSON/.test(lastUser)) {
        const bizSection = lastUser.split('Bisnis aktif')[1]?.split('Shared Services')[0] || '';
        const sharedSection = lastUser.split('Shared Services (tim pusat):')[1]?.split('Tugasmu')[0] || '';
        const biz = slugsIn(bizSection);
        const shared = slugsIn(sharedSection);
        content = JSON.stringify(
          /SIMPLE_TASK/.test(lastUser)
            ? { analysis: 'Sederhana', direct_answer: 'Jawaban langsung dari Group CEO.', business_tasks: [], shared_tasks: [] }
            : {
                analysis: 'Evaluasi per bisnis.',
                direct_answer: null,
                business_tasks: biz.map((s) => ({ business: s, title: `Evaluasi ${s}`, description: 'Evaluasi kinerja bulan ini', priority: 'high' })),
                shared_tasks: shared.length && biz.length && /WITH_SHARED/.test(lastUser)
                  ? [{ assignee: shared[0], business: biz[0], title: 'Analisis biaya', description: 'Analisis biaya bisnis', priority: 'normal' }]
                  : [],
              }
        );
      } else if (/RENCANA_JSON/.test(lastUser) && /Tugas bisnis/.test(lastUser)) {
        // Business Manager planning -> one subtask to the first non-shared team member (or direct answer).
        const teamSection = lastUser.split('Tim yang dapat kamu tugaskan:')[1]?.split('Tugasmu')[0] || '';
        const member = teamSection.split('\n').find((l) => /slug "/.test(l) && !/Shared Services/.test(l));
        const slug = member ? member.match(/slug "([^"]+)"/)[1] : null;
        content = JSON.stringify(
          slug
            ? { analysis: 'Perlu tim.', direct_answer: null, subtasks: [{ title: 'Kerjakan analisis', description: 'Analisis detail', assignee: slug, priority: 'normal' }] }
            : { analysis: 'Langsung.', direct_answer: 'Laporan bisnis langsung dari manager.', subtasks: [] }
        );
      } else if (/RENCANA_JSON/.test(lastUser)) {
        content = 'Rencana:\n```json\n' + JSON.stringify({
          analysis: 'Instruksi membutuhkan riset dan konten pemasaran.',
          direct_answer: null,
          subtasks: [
            { title: 'Riset pasar', description: 'Analisis kompetitor', assignee: 'researcher', priority: 'high' },
            { title: 'Draf caption', description: 'Buat 3 caption', assignee: 'marketing', priority: 'normal' },
          ],
        }) + '\n```';
      }
      if (/SIMPLE_TASK/.test(lastUser) && /RENCANA_JSON/.test(lastUser)) {
        content = JSON.stringify({ analysis: 'Sederhana', direct_answer: 'Jawaban langsung dari CEO.', subtasks: [] });
      }
      // Models that answer in JSON where people expect text (real cases seen with some providers).
      if (/PLAN_NO_LIST/.test(lastUser) && /RENCANA_HOLDING_JSON/.test(lastUser)) {
        content = JSON.stringify({ analysis: 'Owner menanyakan tren kopi minggu ini; cukup dijawab langsung.', direct_answer: null });
      }
      if (/PLAN_TRUNCATED/.test(lastUser) && /RENCANA_HOLDING_JSON/.test(lastUser)) {
        content = '{"analysis": "Tren minggu ini", "direct_answer": "Tren kopi susu naik 20% dan pelanggan baru banyak datang dari Instagram, sehingga';
      }
      // Agent scenarios (tool calls with the <tool_call> protocol). The task text is in the first user message; tool
      // results come back as later user messages.
      const userText = data.messages.filter((x) => x.role === 'user').map((x) => x.content).join('\n');
      const finalAsked = /Batas langkah alat tercapai/.test(lastUser);
      if (/AGENT_DOC/.test(userText)) {
        if (/Hasil alat drive_simpan_dokumen/.test(lastUser)) content = `SOP sudah saya simpan di Google Drive: ${(lastUser.match(/https?:\/\/\S+/) || ['-'])[0]}`;
        else if (/RAWNL/.test(userText)) content = 'Saya simpan dulu.\n<tool_call>{"name": "drive_simpan_dokumen", "args": {"judul": "Catatan Rapat", "isi": "# Notulen\n- Harga naik\n- Promo bundling"}}</tool_call>';
        else if (/DRAFT_BEFORE/.test(userText)) content = '# Rencana Promo\n\nPromo bundling kopi + roti setiap akhir pekan selama satu bulan, target 50 paket per minggu.\n\n<tool_call>{"name": "drive_simpan_dokumen", "args": {"judul": "Rencana Promo"}}</tool_call>';
        else content = 'Berikut SOP-nya.\n\n<tool_call>{"name": "drive_simpan_dokumen", "args": {"judul": "SOP Barista", "isi": "# SOP Barista\\n\\n1. Cuci tangan\\n2. Kalibrasi grinder\\n\\n**Wajib** setiap pagi."}}</tool_call>';
      }
      if (/AGENT_SHARE/.test(userText)) {
        const file = (userText.match(/file=(#\d+)/) || [])[1] || '#0';
        content = /Menunggu persetujuan owner/.test(lastUser) ? 'Permintaan berbagi menunggu persetujuan owner.'
          : `<tool_call>{"name": "drive_bagikan", "args": {"file": "${file}", "email": "budi@example.com"}}</tool_call>`;
      }
      if (/AGENT_READ/.test(userText)) {
        const file = (userText.match(/file=(#\d+)/) || [])[1] || '#0';
        content = /drive_baca/.test(lastUser) || /gagal/.test(lastUser) ? `Selesai membaca: ${lastUser.slice(0, 200)}` : `<tool_call>{"name": "drive_baca", "args": {"file": "${file}"}}</tool_call>`;
      }
      if (/AGENT_BADTOOL/.test(userText)) {
        content = /tidak tersedia/.test(lastUser) ? 'Jawaban akhir tanpa alat.' : '<tool_call>{"name": "hapus_semua_data", "args": {}}</tool_call>';
      }
      if (/AGENT_LOOP/.test(userText)) {
        content = finalAsked ? 'Selesai setelah batas langkah.' : '<tool_call>{"name": "catatan_cari", "args": {"query": "kopi"}}</tool_call>';
      }
      // Developer building a website: create repo -> files (code blocks before the call) -> optional publish -> answer.
      let finish = 'stop';
      if (/AGENT_SITE/.test(userText)) {
        const repo = (userText.match(/repo=([a-z0-9-]+)/) || [])[1] || 'toko-kopi-web';
        if (/Menunggu persetujuan owner/.test(lastUser)) content = 'Website siap; penerbitan menunggu persetujuan owner.';
        else if (/Hasil alat situs_terbitkan|situs_terbitkan gagal/.test(lastUser)) content = `Terbit: ${lastUser.slice(0, 300)}`;
        else if (/Hasil alat github_simpan_file/.test(lastUser)) {
          content = /AGENT_PUBLISH/.test(userText)
            ? `<tool_call>{"name": "situs_terbitkan", "args": {"repo": "${repo}"${/HOST=(\w+)/.test(userText) ? `, "layanan": "${userText.match(/HOST=(\w+)/)[1]}"` : ''}}}</tool_call>`
            : `Website selesai. ${(lastUser.match(/Pratinjau: \S+/) || [''])[0]}`;
        } else if (/github_simpan_file gagal/.test(lastUser)) content = `Gagal menyimpan: ${lastUser.slice(0, 200)}`;
        else if (/Hasil alat github_buat_repo/.test(lastUser) || /EXISTING/.test(userText)) {
          content = 'Berikut halamannya.\n\nFile: index.html\n```html\n<!doctype html>\n<html lang="id"><head><link rel="stylesheet" href="style.css"></head>\n<body><h1>SITE_MARKER_HTML Toko Kopi</h1></body></html>\n```\n\n### style.css\n```css\nbody { font-family: sans-serif; color: #3b2a1a; }\n```\n\n'
            + `<tool_call>{"name": "github_simpan_file", "args": {"repo": "${repo}", "pesan": "Halaman utama"}}</tool_call>`;
        } else if (/github_buat_repo gagal/.test(lastUser)) content = `Gagal membuat repo: ${lastUser.slice(0, 200)}`;
        else content = `<tool_call>{"name": "github_buat_repo", "args": {"nama": "${repo}", "jenis": "website", "deskripsi": "Website Toko Kopi"}}</tool_call>`;
      }
      // A file cut off by the output limit, then a shorter retry.
      if (/AGENT_TRUNC/.test(userText)) {
        if (/terpotong/.test(lastUser)) content = 'Saya tulis lebih pendek nanti.';
        else {
          content = 'File: index.html\n```html\n<!doctype html>\n<p>panjang sekali';
          finish = 'length';
        }
      }
      // Paths that must be refused.
      if (/AGENT_BADPATH/.test(userText)) {
        content = /github_simpan_file gagal/.test(lastUser) ? `Ditolak: ${lastUser.slice(0, 200)}`
          : 'File: .github/workflows/deploy.yml\n```yaml\non: push\n```\n<tool_call>{"name": "github_simpan_file", "args": {"repo": "toko-kopi-web"}}</tool_call>';
      }
      // Old habit: "DATA NOT AVAILABLE" in every section.
      if (/DNA_REPORT/.test(lastUser) && !/RENCANA_/.test(lastUser)) {
        content = '## Ringkasan\nPenjualan stabil. Omzet: DATA NOT AVAILABLE.\n\n## Hasil Utama\nDATA NOT AVAILABLE\n\n## Peluang\n- DATA NOT AVAILABLE\n\n## Rekomendasi\n- Uji paket bundling (estimasi harga pasar Rp25.000–35.000 [W1]).';
      }
      if (/JSON_REPLY/.test(lastUser) && !/RENCANA_/.test(lastUser)) {
        content = '```json\n' + JSON.stringify({ reply: 'Halo owner, tren kopi susu gula aren sedang naik.', poin_penting: ['Kopi susu gula aren', 'Cold brew'], status: 'ok' }) + '\n```';
      }
      return send(200, {
        model: m,
        choices: [{ message: { role: 'assistant', content }, finish_reason: finish }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });
    }
    send(404, { error: { message: 'not found' } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}
