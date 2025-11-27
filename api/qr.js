const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// URL finale: area personale
const ACCOUNT_URL = 'https://www.devs-store.it/pages/account';

// --------------------------------------------------------------
// CREA UN ORDINE SU SHOPIFY PER SBLOCCARE IL PRODOTTO
// --------------------------------------------------------------
async function createQrOrderForCustomer({ customerId, productId, code }) {
  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const shopifyToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-07';

  if (!shopifyDomain || !shopifyToken) {
    console.error('Shopify env vars missing, skip order creation');
    return;
  }
  if (!customerId || !productId) {
    console.error('Missing customerId or productId for QR order');
    return;
  }

  try {
    // 1) prendi il prodotto → per trovare un variant_id valido
    const prodRes = await fetch(
      `https://${shopifyDomain}/admin/api/${apiVersion}/products/${productId}.json`,
      {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': shopifyToken,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!prodRes.ok) {
      const text = await prodRes.text();
      console.error('Error fetching product:', prodRes.status, text);
      return;
    }

    const prodData = await prodRes.json();
    const product = prodData.product;
    if (!product || !product.variants || !product.variants.length) {
      console.error('No variants found for product', productId);
      return;
    }

    const variantId = product.variants[0].id;

    // 2) crea un ordine a 0€ per quel variant
    const orderPayload = {
      order: {
        customer: { id: Number(customerId) },
        financial_status: "paid",
        line_items: [
          {
            variant_id: variantId,
            quantity: 1,
            price: "0.00"
          }
        ],
        note: `Sblocco tramite QR code ${code}`
      }
    };

    const orderRes = await fetch(
      `https://${shopifyDomain}/admin/api/${apiVersion}/orders.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': shopifyToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(orderPayload)
      }
    );

    if (!orderRes.ok) {
      const text = await orderRes.text();
      console.error('Error creating QR unlock order:', orderRes.status, text);
      return;
    }

    const orderData = await orderRes.json();
    console.log('QR unlock order created for customer:', orderData.order?.id);

  } catch (err) {
    console.error('Error in createQrOrderForCustomer:', err);
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

  // 1️⃣ Cerca il QR in Supabase
  const { data: qrRow, error: qrError } = await supabase
    .from('qr_codes')
    .select('*')
    .eq('code', code)
    .single();

  if (qrError || !qrRow) {
    console.error('QR not found:', qrError);
    return res.status(404).send('QR non valido o non registrato.');
  }

  // 2️⃣ Se è già stato usato → blocca
  if (qrRow.first_scanned_at) {
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

  // 4️⃣ Marca il QR come "usato"
  await supabase
    .from('qr_codes')
    .update({
      first_scanned_at: new Date().toISOString(),
      status: 'used'
    })
    .eq('id', qrRow.id);

  // 5️⃣ CREA L’ORDINE SU SHOPIFY → “come se avesse comprato il prodotto”
  if (customerId && qrRow.shopify_product_id) {
    createQrOrderForCustomer({
      customerId,
      productId: qrRow.shopify_product_id,
      code
    });
  }

  // 6️⃣ Redirect finale
  res.writeHead(302, { Location: ACCOUNT_URL });
  res.end();
};
