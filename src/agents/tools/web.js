// Web tools (no API key): search news/web and read one public page. Reuses the research module (SSRF guard,
// timeouts, size limits, cache, honest bot User-Agent).
import { getSetting } from '../../lib/settings.js';
import { truncate } from '../../lib/text.js';
import { searchNews, searchWeb, readPage, assertPublicUrl } from '../../research/web.js';

const enabled = () => getSetting('web_research_enabled');

export const webTools = [
  {
    name: 'web_cari',
    risk: 'safe',
    connector: null,
    allowed: enabled,
    description: 'Cari berita dan halaman web terbaru di internet (Google News + pencarian web). Hasil: judul, sumber, tautan.',
    args: { query: { type: 'string', required: true, max: 200, desc: 'kata kunci pencarian' } },
    async run(ctx, { query }) {
      const [news, web] = await Promise.all([
        searchNews(query, 5).catch(() => []),
        searchWeb(query, 5).catch(() => []),
      ]);
      const lines = [
        ...news.map((n) => `- [berita] ${n.title}${n.source ? ` — ${n.source}` : ''}${n.date ? ` · ${n.date}` : ''} · ${n.link}`),
        ...web.map((w) => `- [web] ${w.title}${w.snippet ? ` — ${truncate(w.snippet, 200)}` : ''} · ${w.link}`),
      ];
      return {
        text: lines.length ? `Hasil pencarian "${query}":\n${lines.join('\n')}` : `Tidak ada hasil untuk "${query}" (sumber tidak terjangkau atau kosong).`,
        summary: `${lines.length} hasil untuk "${truncate(query, 60)}"`,
      };
    },
  },
  {
    name: 'web_baca',
    risk: 'safe',
    connector: null,
    allowed: enabled,
    description: 'Baca isi teks satu halaman web publik (maks ±4.000 karakter).',
    args: { url: { type: 'string', required: true, max: 500, pattern: /^https?:\/\//i, hint: 'harus diawali http:// atau https://' } },
    async run(ctx, { url }) {
      await assertPublicUrl(url);
      const page = await readPage(url, 4000);
      return {
        text: page.text ? `${page.title ? `${page.title}\n` : ''}${page.text}` : 'Halaman tidak berisi teks yang bisa dibaca.',
        summary: `membaca ${truncate(page.title || url, 80)}`,
        links: [{ title: page.title || url, url }],
      };
    },
  },
];
