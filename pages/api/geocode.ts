import type { NextApiRequest, NextApiResponse } from 'next';
import { geocodeAddress } from '@/lib/geocode';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (process.env.MAP_SECRET && req.query.key !== process.env.MAP_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const addresses = body?.addresses;
    if (!Array.isArray(addresses)) {
      res.status(400).json({ error: 'addresses must be an array' });
      return;
    }
    const results:any[] = [];
    for (const address of addresses) {
      if (typeof address !== 'string' || !address.trim()) continue;
      const g = await geocodeAddress(address);
      if (g) results.push({ address, ...g });
    }
    res.status(200).json(results);
  } catch (e:any) {
    console.error(e);
    res.status(500).json({ error: e.message || 'server_error' });
  }
}
