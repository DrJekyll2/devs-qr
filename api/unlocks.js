const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
const shopifyToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const shopifyApiVersion = process.env.SHOPIFY_API_VERSION || '2024-07';

// Helper CORS
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.devs-store.it');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const customerId = (req.query.customerId || '').trim();

  if (!customerId) {
    return res.status(400).json({ error: 'Missing customerId' });
  }

  if (!shopifyDomain || !shopifyToken) {
    console.error('Shopify env vars missing');
    return res.status(500).json({ error: 'Shopify not configured' });
  }

  try {
    // 1) prendo tutte le scansioni di questo cliente
    const { data: scans, error: scansError } = await supabase
      .from('qr_scans')
      .select('qr_code_id')
      .eq('customer_id', customerId);

    if (scansError) {
      console.error('Scans error:', scansError);
      return res.status(500).json({ error: 'Failed to fetch scans' });
    }

    const qrIds = [...new Set((scans || []).map(s => s.qr_code_id).filter(Boolean))];

    if (!qrIds.length) {
      // Nessun prodotto sbloccato
      return res.json([]);
    }

    // 2) prendo i QR codes corrispondenti
    const { data: codes, error: codesError } = await supabase
      .from('qr_codes')
      .select('shopify_product_id')
      .in('id', qrIds);

    if (codesError) {
      console.error('Codes error:', codesError);
      return res.status(500).json({ error: 'Failed to fetch codes' });
    }

    const productIds = [...new Set(
      (codes || [])
        .map(c => c.shopify_product_id)
        .filter(Boolean)
    )];

    if (!productIds.length) {
      return res.json([]);
    }

    // 3) chiamo Shopify Admin API per prendere i dettagli dei prodotti
    const idsParam = productIds.join(',');
    const url = `https://${shopifyDomain}/admin/api/${shopifyApiVersion}/products.json?ids=${encodeURIComponent(idsParam)}`;

    const shopifyRes = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': shopifyToken,
        'Content-Type': 'application/json'
      }
    });

    if (!shopifyRes.ok) {
      const text = await shopifyRes.text();
      console.error('Shopify error:', shopifyRes.status, text);
      return res.status(500).json({ error: 'Failed to fetch products from Shopify' });
    }

    const data = await shopifyRes.json();
    const products = Array.isArray(data.products) ? data.products : [];

    // 4) Risposta semplificata per il frontend
    const result = products.map(p => ({
      id: p.id,
      handle: p.handle,
      title: p.title,
      image: p.image?.src || (p.images && p.images[0]?.src) || null,
      online_store_url: p.online_store_url || (p.handle ? `https://www.devs-store.it/products/${p.handle}` : null)
    }));

    return res.json(result);
  } catch (err) {
    console.error('Unhandled error in /api/unlocks:', err);
    return res.status(500).json({ error: 'Unexpected error' });
  }
};
