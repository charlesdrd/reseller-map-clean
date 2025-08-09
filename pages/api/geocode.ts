// pages/api/geocode.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { geocodeAddress } from '@/lib/geocode';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    // sécurité simple
    if (process.env.MAP_SECRET && req.query.key !== process.env.MAP_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'method_not_allowed' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const address = typeof body?.address === 'string' ? body.address.trim() : '';
    if (!address) return res.status(400).json({ error: 'invalid_address' });

    // géocodage (OpenCage -> fallback Nominatim)
    const coords = await geocodeAddress(address);

    // si rien trouvé, renvoyer 404 (et pas 200)
    if (!coords) {
      return res.status(404).json({ error: 'geocode_not_found' });
    }

    return res.status(200).json({ address, ...coords });
  } catch (e: any) {
    console.error('api/geocode error:', e);
    return res.status(500).json({ error: e?.message || 'server_error' });
  }
}