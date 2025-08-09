import type { NextApiRequest, NextApiResponse } from 'next';
import { geocodeAddress } from '@/lib/geocode';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (process.env.MAP_SECRET && req.query.key !== process.env.MAP_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const raw = Array.isArray(body?.addresses)
    ? (body.addresses as unknown[])
    : (typeof body?.address === 'string' ? [body.address] : []);

  const uniq: string[] = Array.from(
    new Set(
      raw
        .filter((a): a is string => typeof a === 'string')
        .map((a) => a.trim())
        .filter(Boolean)
    )
  ).slice(0, 400); // borne soft pour éviter d’exploser la quota

  const out: Array<{ address: string; lat: number; lng: number }> = [];

  for (let i = 0; i < uniq.length; i++) {
    const address = uniq[i];

    // Respect OpenCage (≈ 1 req/s sur le plan gratuit)
    if (i > 0) await sleep(1100);

    try {
      const g = await geocodeAddress(address);
      if (g) out.push({ address, ...g });
    } catch (e) {
      console.error('geocode failed for', address, e);
      // on continue même en cas d’échec unitaire
    }
  }

  return res.status(200).json(out);
}
