const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// URL finale fisso: area personale
const ACCOUNT_URL = 'https://www.devs-store.it/pages/account';

// Vercel serverless function
module.exports = async (req, res) => {
  const code = (req.query.code || '').trim();

  if (!code) {
    return res.status(400).send('Missing QR code');
  }

  // IP + User Agent
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0] ||
    req.socket?.remoteAddress ||
    null;

  const userAgent = req.headers['user-agent'] || null;

  // Dati cliente passati dalla pagina Shopify (T-Square / TESTQR)
  const customerId = (req.query.customerId || '').trim() || null;
  const customerEmail = (req.query.customerEmail || '').trim() || null;

  // 1. Recupera il QR da Supabase
  const { data: qrRow, error: qrError } = await supabase
    .from('qr_codes')
    .select('*')
    .eq('code', code)
    .single();

  if (qrError || !qrRow) {
    console.error('QR not found:', qrError);
    return res.status(404).send('QR non valido o non registrato.');
  }

  // 2. Controlla se il QR è già stato usato (one-time use)
  if (qrRow.first_scanned_at) {
    // QR già utilizzato → NON reindirizziamo più all’area personale
    const html = `
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>QR già utilizzato</title>
          <style>
            body {
              margin: 0;
              padding: 0;
              font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
              background: #050505;
              color: #f5f5f5;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
            }
            .box {
              text-align: center;
              padding: 24px 20px;
              border-radius: 16px;
              border: 1px solid #333;
              max-width: 360px;
            }
            h1 {
              font-size: 20px;
              margin-bottom: 8px;
            }
            p {
              font-size: 14px;
              line-height: 1.5;
              opacity: 0.85;
            }
            a {
              color: #fff;
              text-decoration: underline;
            }
          </style>
        </head>
        <body>
          <div class="box">
            <h1>QR già utilizzato</h1>
            <p>
              Questo codice QR è già stato usato in precedenza e non è più valido.
            </p>
            <p>
              Se pensi ci sia un errore, accedi alla tua
              <a href="https://www.devs-store.it/pages/account">area personale</a>
              o contatta il supporto Devs Store.
            </p>
          </div>
        </body>
      </html>
    `;
    return res.status(410).send(html);
  }

  // 3. Logga la scansione (prima volta)
  const { error: logError } = await supabase.from('qr_scans').insert({
    qr_code_id: qrRow.id,
    customer_id: customerId,
    customer_email: customerEmail,
    ip_address: ip,
    user_agent: userAgent,
    extra: null
  });

  if (logError) {
    console.error('Log error:', logError);
  }

  // 4. Segna il QR come "usato" (prima scansione)
  const nowIso = new Date().toISOString();

  const { error: updateError } = await supabase
    .from('qr_codes')
    .update({
      first_scanned_at: nowIso,
      status: 'used'
    })
    .eq('id', qrRow.id);

  if (updateError) {
    console.error('Update error:', updateError);
    // comunque proseguiamo col redirect
  }

  // 5. Redirect all'area personale
  res.writeHead(302, { Location: ACCOUNT_URL });
  res.end();
};
