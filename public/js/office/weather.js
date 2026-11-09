// Weather for the office front yard.
// - Manual: the owner picks cerah / berawan / hujan / badai.
// - Otomatis: real current weather from Open-Meteo (free, no API key), fetched by the browser for a city the owner
//   chose (coordinates rounded to ~1 km). Refreshed every 15 minutes while the office page is open.
// Settings are a per-browser display preference (localStorage); nothing is stored on the server.
const KEY = 'office.weather.v1';
export const KINDS = { cerah: 'Cerah', berawan: 'Berawan', hujan: 'Hujan', badai: 'Badai petir' };
// Time of day shown in the office: the browser clock (auto) or a fixed period chosen by the owner.
export const TIMES = { auto: 'Otomatis (jam browser)', morning: 'Pagi', afternoon: 'Siang', evening: 'Sore', night: 'Malam' };
export const REFRESH_MS = 15 * 60 * 1000;

const validPlace = (p) => p && typeof p.name === 'string' && Number.isFinite(p.lat) && Number.isFinite(p.lon) ? { name: p.name.slice(0, 120), lat: p.lat, lon: p.lon } : null;

export function loadWeatherSettings() {
  const def = { mode: 'manual', manual: 'cerah', place: null, last: null, time: 'auto' };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!s || typeof s !== 'object') return def;
    const last = s.last && KINDS[s.last.kind] && Number.isFinite(s.last.at) ? s.last : null;
    return { mode: s.mode === 'auto' ? 'auto' : 'manual', manual: KINDS[s.manual] ? s.manual : 'cerah', place: validPlace(s.place), last, time: TIMES[s.time] ? s.time : 'auto' };
  } catch {
    return def;
  }
}

export function saveWeatherSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ mode: s.mode, manual: s.manual, place: s.place, last: s.last, time: s.time }));
  } catch {
    /* private mode / storage blocked: settings last for this page only */
  }
}

// WMO weather interpretation codes (Open-Meteo) -> office weather + Indonesian label.
export function fromWmo(code) {
  if (code === 0) return { kind: 'cerah', label: 'Cerah' };
  if (code === 1) return { kind: 'cerah', label: 'Cerah berawan' };
  if (code === 2) return { kind: 'berawan', label: 'Berawan sebagian' };
  if (code === 3) return { kind: 'berawan', label: 'Mendung' };
  if (code === 45 || code === 48) return { kind: 'berawan', label: 'Berkabut' };
  if (code >= 51 && code <= 57) return { kind: 'hujan', label: 'Gerimis' };
  if (code >= 61 && code <= 67) return { kind: 'hujan', label: code >= 65 ? 'Hujan lebat' : 'Hujan' };
  if (code >= 71 && code <= 77) return { kind: 'hujan', label: 'Salju' };
  if (code >= 80 && code <= 82) return { kind: 'hujan', label: code === 82 ? 'Hujan deras' : 'Hujan lokal' };
  if (code === 85 || code === 86) return { kind: 'hujan', label: 'Hujan salju' };
  if (code >= 95) return { kind: 'badai', label: 'Badai petir' };
  return { kind: 'cerah', label: `Kode cuaca ${code}` };
}

async function getJson(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ac.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Open-Meteo tidak merespons' : e.message || 'Gagal menghubungi Open-Meteo');
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCurrentWeather(place) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&current=temperature_2m,weather_code&timezone=auto`;
  const j = await getJson(u);
  const c = j.current;
  if (!c || typeof c.weather_code !== 'number') throw new Error('Data cuaca dari Open-Meteo tidak lengkap');
  return { ...fromWmo(c.weather_code), code: c.weather_code, temp: Math.round(c.temperature_2m), at: Date.now() };
}

export async function searchPlaces(q) {
  const j = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=id&format=json`);
  return (j.results || []).map((r) => ({
    name: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
    lat: Math.round(r.latitude * 100) / 100,
    lon: Math.round(r.longitude * 100) / 100,
  }));
}
