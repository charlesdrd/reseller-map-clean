import { getCoords, setCoords } from './cache';

export async function geocodeAddress(address: string): Promise<{lat:number, lng:number} | null> {
  const cached = getCoords(address);
  if (cached) return cached;

  const key = process.env.OPENCAGE_KEY!;
  if (!key) throw new Error('Missing OPENCAGE_KEY');

  const url = `https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(address)}&key=${key}`;
  const r = await fetch(url);
  if (!r.ok) {
    console.error('Geocode error', r.status);
    return null;
  }
  const j = await r.json();
  const g = j?.results?.[0]?.geometry;
  if (!g) return null;

  setCoords(address, g.lat, g.lng);
  return { lat: g.lat, lng: g.lng };
}
