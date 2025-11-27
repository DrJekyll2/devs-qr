const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

const ACCOUNT_URL = 'https://www.devs-store.it/pages/account';

// --------------------------------------------------------------
// CREA UN ORDINE SU SHOPIFY PER SBLOCCARE IL PRODOTTO (DEBUG)
// --------------------------------------------------------------
async function createQrOrderForCustomer({ customerId, productId, code }) {
  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const shopifyToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-07';

  console.error('[QR] createQrOrderForCustomer START', {
    customerId,
    productId,
    shopifyDomainPresent: !!shopifyDomain,
    tokenPresent: !!shopifyToken,
    apiVersion
  });

  if (!shopifyDomain || !shopifyToken) {
    console.error('[QR] Shopify env vars missing, skip order creation');
    return;
  }
  if (!customerId || !productId) {
    console.error('[QR] Missing customerId or productId for QR order');
    return;
  }

  try {
    // 1) prendo il prodotto → per trovare un variant_id valido
    const prodUrl = `https://${shopifyDomain}/admin/api/${apiVersion}/products/${productId}.json`;
    console.error('[QR] Fetch product URL', prodUrl);

    const prodRes = await fetch(prodUrl, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': shopifyToken,
        'Content-Type': 'application/json'
      }
    });

    console.error('[QR] Product response status', prodRes.status);

    if (!prodRes.ok) {
      const text = await prodRes.text();
      console.error('[QR] Error fetching product:', prodRes.status, text);
      return;
    }

    const prodData = await prodRes.json();
    const product = prodData.product;
    if (!product || !product.variants || !product.variants.length) {
      console.error('[QR] No variants found for product', productId);
      return;
    }

    const variantId = product.variants[0].id;
    console.error('[QR] Using variantId', variantId);

    // 2) crea un ordine a 0€ per quel variant
    const orderPayload = {
      order: {
        customer: { id: Number(customerId) },
        financial_status: 'paid',
        line_items: [
          {
            variant_id: variantId,
            quantity: 1,
            price: '0.00'
          }
        ],
        note: `Sblocco tramite QR code ${code}`
      }
    };

    const orderUrl = `https://${shopifyDomain}/admin/api/${apiVersion}/orders.json`;
    console.error('[QR] Create order URL', orderUrl);

    const orderRes = await fetch(orderUrl, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': shopifyToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(orderPayload)
    });

    console.error('[QR] Order response status', orderRes.status);

    if (!orderRes.ok) {
      const text = await orderRes.text();
      console.error('[QR] Error creating QR unlock order:', orderRes.status, text);
      return;
    }

    const orderData = await orderRes.json();
    console.error('[QR] QR unlock order created for customer:', orderData.order?.id);

  } catch (err) {
    console.error('[QR] Error in createQrOrderForCustomer:', err);
  }
}

// --------------------------------------------------------------
// ENDPOINT PRINCIPALE: /api/qr?code=XXXX
// --------------------------------------------------------------
module.exports = async (req, res) => {
  const code = (req.query.code || '').trim();

  if (!code) {
    return res.status(400).send('Missing QR code');
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0] ||
    req.socket?.remoteAddress ||
    null;

  const userAgent = req.headers['user-agent'] || null;

  const customerId = (req.query.customerId || '').trim() || null;
  const customerEmail = (req.query.customerEmail || '').trim() || null;

  console.error('[QR] HANDLER START', {
    code,
    customerId,
    customerEmail
  });

  // 1️⃣ Cerca il QR in Supabase
  const { data: qrRow, error: qrError } = await supabase
    .from('qr_codes')
    .select('*')
    .eq('code', code)
    .single();

  if (qrError || !qrRow) {
    console.error('[QR] QR not found:', qrError);
    return res.status(404).send('QR non valido o non registrato.');
  }

  console.error('[QR] QR row loaded', {
    id: qrRow.id,
    status: qrRow.status,
    product_handle: qrRow.product_handle,
    shopify_product_id: qrRow.shopify_product_id
  });

  // 2️⃣ Se è già stato usato → blocca
  if (qrRow.first_scanned_at) {
    console.error('[QR] QR already used, blocking');
    const BLOCK_HTML = `
      <html>
        <head>
          <meta charset="utf-8"/>
          <meta name="viewport" content="width=device-width, initial-scale=1"/>
          <title>QR già utilizzato</title>
          <style>
            body {
              margin:0;
              padding:0;
              background:#050505;
              color:#eee;
              font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
              display:flex;
              justify-content:center;
              align-items:center;
              min-height:100vh;
            }
            .box {
              padding:20px;
              border:1px solid #333;
              border-radius:12px;
              text-align:center;
              max-width:340px;
            }
            h1 { margin-bottom:10px; font-size:20px; }
            p { opacity:0.9; font-size:14px; line-height:1.4; }
            a { color:white; text-decoration:underline; }
          </style>
        </head>
        <body>
          <div class="box">
            <h1>QR già utilizzato</h1>
            <p>Questo QR è già stato usato e non può essere riutilizzato.</p>
            <p>Vai alla <a href="https://www.devs-store.it/pages/account">tua area personale</a>.</p>
          </div>
        </body>
      </html>
    `;
    return res.status(410).send(BLOCK_HTML);
  }

  // 3️⃣ Logga la scansione
  await supabase.from('qr_scans').insert({
    qr_code_id: qrRow.id,
    customer_id: customerId,
    customer_email: customerEmail,
    ip_address: ip,
    user_agent: userAgent
  });

  console.error('[QR] Scan logged');

  // 4️⃣ Marca il QR come "usato"
  await supabase
    .from('qr_codes')
    .update({
      first_scanned_at: new Date().toISOString(),
      status: 'used'
    })
    .eq('id', qrRow.id);

  console.error('[QR] QR marked as used');

  // 5️⃣ CREA L’ORDINE SU SHOPIFY → “come se avesse comprato il prodotto”
  try {
    if (customerId && qrRow.shopify_product_id) {
      console.error('[QR] Calling createQrOrderForCustomer');
      await createQrOrderForCustomer({
        customerId,
        productId: qrRow.shopify_product_id,
        code
      });
    } else {
      console.error('[QR] Missing customerId or shopify_product_id, skip order', {
        customerId,
        shopify_product_id: qrRow.shopify_product_id
      });
    }
  } catch (err) {
    console.error('[QR] Error calling createQrOrderForCustomer (outer):', err);
  }

  // 6️⃣ Redirect finale
  res.writeHead(302, { Location: ACCOUNT_URL });
  res.end();
};
