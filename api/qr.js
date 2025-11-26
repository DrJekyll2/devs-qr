const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseServiceKey);

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

  // In futuro: qui potremo mettere customerId / email da Shopify
  const customerId = null;
  const customerEmail = null;

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

  const productUrl = qrRow.product_url;

  // 2. Logga la scansione
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

  // 3. Se è la prima volta, aggiorna lo stato
  if (!qrRow.first_scanned_at) {
    await supabase
      .from('qr_codes')
      .update({
        first_scanned_at: new Date().toISOString(),
        status: 'scanned'
      })
      .eq('id', qrRow.id);
  }

  // 4. Redirect alla pagina del prodotto
  res.writeHead(302, { Location: productUrl });
  res.end();
};
