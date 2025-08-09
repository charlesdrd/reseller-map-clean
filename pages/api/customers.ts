import type { NextApiRequest, NextApiResponse } from 'next';

const GQL = `
  query($cursor: String) {
    customers(first: 250, after: $cursor, query: "tag:wls") {
      edges {
        cursor
        node {
          id
          displayName
          # Metafields
          addressMeta: metafield(namespace:"custom", key:"address"){ value }
          wholesaleMeta: metafield(namespace:"custom", key:"wholesale"){ value }
          # Dernière commande
          orders(first: 1, sortKey: PROCESSED_AT, reverse: true) {
            edges { node { processedAt } }
          }
          # Fallback: adresse Shopify par défaut
          defaultAddress { address1 address2 city zip province country }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;

function formatDefaultAddress(a?: {
  address1?: string|null; address2?: string|null; city?: string|null;
  zip?: string|null; province?: string|null; country?: string|null;
}): string | null {
  if (!a) return null;
  const parts = [a.address1, a.address2, a.zip, a.city, a.province, a.country]
    .filter(Boolean).map(s => String(s).trim());
  return parts.length ? parts.join(', ') : null;
}

async function fetchPage(cursor: string | null) {
  const shop = process.env.SHOPIFY_SHOP!;
  const token = process.env.SHOPIFY_TOKEN!;
  const url = `https://${shop}.myshopify.com/admin/api/2025-01/graphql.json`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query: GQL, variables: { cursor } })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Shopify HTTP ${r.status}`);
  if (!j?.data?.customers) {
    console.error('Shopify GraphQL errors:', j?.errors);
    throw new Error('Shopify GraphQL returned null (check scopes/token)');
  }
  return j;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (process.env.MAP_SECRET && req.query.key !== process.env.MAP_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    let cursor: string | null = null;
    const out: Array<{
      name: string;
      address: string;
      addressSource: 'custom'|'default';
      lastOrderAt: string|null;
      wholesale: boolean; // validé ou non
    }> = [];

    while (true) {
      const j = await fetchPage(cursor);
      const edges = j.data.customers.edges ?? [];

      for (const e of edges) {
        const n = e.node;
        const metaAddr = n?.addressMeta?.value?.trim() || null;
        const fallback = formatDefaultAddress(n?.defaultAddress);
        const address = metaAddr || fallback;
        if (!address) continue;

        const addressSource: 'custom'|'default' = metaAddr ? 'custom' : 'default';
        const lastOrderAt = n?.orders?.edges?.[0]?.node?.processedAt ?? null;
        const wholesale = !!(n?.wholesaleMeta?.value); // validé si metaobject présent

        out.push({ name: n.displayName, address, addressSource, lastOrderAt, wholesale });
      }

      if (!j.data.customers.pageInfo.hasNextPage) break;
      cursor = edges[edges.length - 1].cursor;
    }

    res.status(200).json(out);
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e.message || 'server_error' });
  }
}
