import type { NextApiRequest, NextApiResponse } from 'next';

const gql = `
  query($cursor: String) {
    customers(first: 250, after: $cursor, query: "tag:wls") {
      edges {
        cursor
        node {
          id
          displayName
          metafield(namespace:"custom", key:"address"){ value }
          wholesaleMeta: metafield(namespace:"custom", key:"wholesale"){ value }
          orders(first: 1, sortKey: PROCESSED_AT, reverse: true) {
            edges { node { processedAt } }
          }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;

async function fetchPage(cursor: string | null) {
  const shop = process.env.SHOPIFY_SHOP;
  const token = process.env.SHOPIFY_TOKEN;
  const url = `https://${shop}.myshopify.com/admin/api/2024-07/graphql.json`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'X-Shopify-Access-Token': token as string },
    body: JSON.stringify({ query: gql, variables: { cursor } })
  });
  if (!r.ok) throw new Error(`Shopify error ${r.status}`);
  return r.json();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (process.env.MAP_SECRET && req.query.key !== process.env.MAP_SECRET) {
    res.status(401).json({ error: 'unauthorized' }); return;
  }
  try {
    let cursor: string | null = null;
    const out: Array<{ name: string; address: string; lastOrderAt?: string|null; wholesale?: string|null }> = [];

    while (true) {
      const j = await fetchPage(cursor);
      const edges = j?.data?.customers?.edges ?? [];

      for (const e of edges) {
        const node = e.node;
        const address = node?.metafield?.value || null; // custom.address
        if (!address) continue;

        const lastOrderAt = node?.orders?.edges?.[0]?.node?.processedAt ?? null;
        const wholesale = node?.wholesaleMeta?.value ?? null;

        out.push({
          name: node.displayName,
          address,
          lastOrderAt,
          wholesale
        });
      }

      if (!j.data.customers.pageInfo.hasNextPage) break;
      cursor = edges[edges.length - 1].cursor;
    }

    res.status(200).json(out);
  } catch (e:any) {
    console.error(e);
    res.status(500).json({ error: e.message || 'server_error' });
  }
}
