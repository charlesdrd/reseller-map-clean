import { getCoords, setCoords } from './cache';

// États US pour deviner ", USA"
const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'
]);

function normalizeAddress(raw: string): string {
  return (raw || '')
    .replace(/[\r\n]+/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

function looksLikeUS(address: string): boolean {
  const m = address.match(/,\s*([A-Z]{2})(\s+\d{5}(-\d{4})?)?$/);
  return !!(m && US_STATES.has(m[1]));
}

function hasCountryWord(address: string): boolean {
  // liste courte de mots pays qu’on voit dans ta base
  const hints = [
    'France','USA','United States','United Kingdom','UK','China','Taiwan','Korea','Republic of Korea',
    'Japan','Singapore','Lebanon','Australia','Netherlands','Holland','Belgium','Canada','Italia','Italy'
  ];
  const a = address.toLowerCase();
  return hints.some(h => a.includes(h.toLowerCase()));
}

async function tryGeocode(q: string): Promise<{lat:number; lng:number} | null> {
  const key = process.env.OPENCAGE_KEY!;
  if (!key) throw new Error('Missing OPENCAGE_KEY');
  const params = new URLSearchParams({
    q, key, limit: '1', no_annotations: '1', abbrv: '1', language: 'en'
  });
  const url = `https://api.opencagedata.com/geocode/v1/json?${params.toString()}`;
  const r = await fetch(url);
  if (!r.ok) {
    console.error('Geocode HTTP error', r.status, q);
    return null;
  }
  const j = await r.json();
  const g = j?.results?.[0]?.geometry;
  return g ? { lat: g.lat, lng: g.lng } : null;
}

export async function geocodeAddress(address: string): Promise<{lat:number, lng:number} | null> {
  const cleaned = normalizeAddress(address);
  if (!cleaned) return null;

  const cached = getCoords(cleaned);
  if (cached) return cached;

  // 1) tentative brute
  let hit = await tryGeocode(cleaned);

  // 2) si pas de pays et format US possible → ", USA"
  if (!hit && !hasCountryWord(cleaned) && looksLikeUS(cleaned)) {
    hit = await tryGeocode(`${cleaned}, USA`);
  }

  // 3) si toujours rien et pas de pays → teste quelques fallbacks courants
  if (!hit && !hasCountryWord(cleaned)) {
    const fallbacks = [ 'France', 'United Kingdom', 'Singapore', 'Australia', 'China', 'Japan', 'Korea', 'Netherlands' ];
    for (const c of fallbacks) {
      hit = await tryGeocode(`${cleaned}, ${c}`);
      if (hit) break;
    }
  }

  if (!hit) return null;
  setCoords(cleaned, hit.lat, hit.lng);
  return hit;
}
