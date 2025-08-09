// lib/geocode.ts
//
// Géocodage avec OpenCage (clé requise) puis fallback Nominatim (OSM).
// Retourne { lat, lng } ou null si introuvable.

type Coords = { lat: number; lng: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// petit cache mémoire (par process). OK en dev, éphémère sur serverless.
const mem = new Map<string, Coords>();

export async function geocodeAddress(address: string): Promise<Coords | null> {
  const key = process.env.OPENCAGE_KEY || '';
  const addr = (address || '').trim();
  if (!addr) return null;

  const memHit = mem.get(addr);
  if (memHit) return memHit;

  // 1) OpenCage
  if (key) {
    try {
      const url = `https://api.opencagedata.com/geocode/v1/json?key=${encodeURIComponent(
        key
      )}&q=${encodeURIComponent(addr)}&limit=1&no_annotations=1&language=en`;

      const r = await fetch(url, { method: 'GET' });
      if (r.ok) {
        const j: any = await r.json();
        const g = j?.results?.[0]?.geometry;
        if (g && typeof g.lat === 'number' && typeof g.lng === 'number') {
          const out = { lat: g.lat, lng: g.lng };
          mem.set(addr, out);
          return out;
        }
      }
      // r non ok → on tente le fallback
    } catch {}
  }

  // 2) Fallback Nominatim (OpenStreetMap)
  // NB: Nominatim nécessite un User-Agent explicite et être utilisé gentiment.
  try {
    // petite pause pour éviter de cogner trop vite si OpenCage a raté
    await sleep(200);

    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
      addr
    )}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Carron-Reseller-Map/1.0 (contact: tech@carron.paris)',
        'Accept-Language': 'en',
      },
    });

    if (r.ok) {
      const arr: any[] = await r.json();
      const first = arr?.[0];
      const lat = first ? parseFloat(first.lat) : NaN;
      const lon = first ? parseFloat(first.lon) : NaN;
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        const out = { lat, lng: lon };
        mem.set(addr, out);
        return out;
      }
    }
  } catch {}

  return null;
}