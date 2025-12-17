import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const APP_ID = process.env.ENABLE_BANKING_APP_ID;
const PRIVATE_KEY_BASE64 = process.env.ENABLE_BANKING_PRIVATE_KEY;
const REDIRECT_URL = process.env.REDIRECT_URL || 'http://localhost:3000/callback';
const FRONTEND_URL = process.env.FRONTEND_URL || '*';
const API_BASE_URL = 'https://api.enablebanking.com';

// Decode private key from base64
let PRIVATE_KEY = null;
if (PRIVATE_KEY_BASE64) {
  PRIVATE_KEY = Buffer.from(PRIVATE_KEY_BASE64, 'base64').toString('utf-8');
}

// In-memory storage for payments
const payments = new Map();

// Middleware - allow all origins
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Generate JWT for Enable Banking API
function generateJWT() {
  if (!PRIVATE_KEY || !APP_ID) {
    throw new Error('Missing Enable Banking credentials');
  }

  const now = Math.floor(Date.now() / 1000);

  const payload = {
    iss: 'enablebanking.com',
    aud: 'api.enablebanking.com',
    iat: now,
    exp: now + 3600 // 1 hour expiry
  };

  const token = jwt.sign(payload, PRIVATE_KEY, {
    algorithm: 'RS256',
    header: {
      alg: 'RS256',
      typ: 'JWT',
      kid: APP_ID
    }
  });

  return token;
}

// Make authenticated request to Enable Banking API
async function enableBankingRequest(method, path, body = null) {
  const token = generateJWT();

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
    console.log(`[Enable Banking] ${method} ${path}`);
    console.log('[Enable Banking] Request body:', JSON.stringify(body, null, 2));
  }

  const url = `${API_BASE_URL}${path}`;
  console.log(`[Enable Banking] Calling: ${url}`);

  const response = await fetch(url, options);
  const responseText = await response.text();

  console.log(`[Enable Banking] Response status: ${response.status}`);
  console.log(`[Enable Banking] Response body: ${responseText.substring(0, 500)}`);

  if (!response.ok) {
    console.error(`Enable Banking API error: ${response.status} - ${responseText}`);
    throw new Error(`API error: ${response.status} - ${responseText}`);
  }

  try {
    return JSON.parse(responseText);
  } catch (e) {
    return { raw: responseText };
  }
}

// Routes

// Health check for Railway
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// List available banks for a country
app.get('/api/banks/:country', async (req, res) => {
  try {
    const { country } = req.params;
    console.log(`[Banks] Fetching banks for country: ${country}`);
    const data = await enableBankingRequest('GET', `/aspsps?country=${country.toUpperCase()}`);
    res.json(data);
  } catch (error) {
    console.error('Error fetching banks:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create a payment
app.post('/api/payments', async (req, res) => {
  console.log('[Payment] Received payment request:', JSON.stringify(req.body, null, 2));

  try {
    const { amount, creditorIban, creditorName, reference, bankName, bankCountry } = req.body;

    if (!amount || !creditorIban || !creditorName || !bankName || !bankCountry) {
      console.log('[Payment] Missing required fields');
      return res.status(400).json({ error: 'Missing required fields', received: req.body });
    }

    const stateId = `payment_${Date.now()}`;
    const timestamp = Date.now();

    // Create payment session with Enable Banking - using correct API format
    const paymentRequest = {
      aspsp: {
        name: bankName,
        country: bankCountry
      },
      state: stateId,
      redirect_url: REDIRECT_URL,
      psu_type: 'personal',
      payment_type: 'SEPA',
      payment_request: {
        credit_transfer_transaction: [{
          instruction_id: `INS${timestamp}`,
          end_to_end_id: `E2E${timestamp}`,
          beneficiary: {
            creditor: {
              name: creditorName
            },
            creditor_account: {
              scheme_name: 'IBAN',
              identification: creditorIban
            }
          },
          instructed_amount: {
            currency: 'EUR',
            amount: amount.toString()
          },
          remittance_information_unstructured: reference || 'Payment'
        }]
      }
    };

    console.log('[Payment] Creating payment session with Enable Banking...');

    // Use /payments endpoint for PIS
    const data = await enableBankingRequest('POST', '/payments', paymentRequest);

    console.log('[Payment] Enable Banking response:', JSON.stringify(data, null, 2));

    // Store payment in memory
    const paymentId = data.payment_id || stateId;
    const payment = {
      id: paymentId,
      amount,
      creditorIban,
      creditorName,
      reference,
      bankName,
      bankCountry,
      status: 'pending',
      authUrl: data.url,
      createdAt: new Date().toISOString(),
      sessionId: data.session_id
    };

    payments.set(paymentId, payment);

    console.log('[Payment] Payment created successfully:', paymentId);

    res.json({
      success: true,
      paymentId,
      authUrl: data.url,
      payment
    });
  } catch (error) {
    console.error('[Payment] Error creating payment:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get payment status
app.get('/api/payments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const payment = payments.get(id);

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // If we have a session ID, check the status with Enable Banking
    if (payment.sessionId) {
      try {
        const data = await enableBankingRequest('GET', `/payments/${payment.sessionId}`);
        if (data.status) {
          payment.status = data.status;
          payments.set(id, payment);
        }
      } catch (err) {
        console.error('Error checking payment status:', err);
      }
    }

    res.json(payment);
  } catch (error) {
    console.error('Error fetching payment:', error);
    res.status(500).json({ error: error.message });
  }
});

// List all payments
app.get('/api/payments', (req, res) => {
  const allPayments = Array.from(payments.values());
  res.json(allPayments);
});

// Connect bank account (AIS)
app.post('/api/connect', async (req, res) => {
  try {
    const { bankName, bankCountry } = req.body;

    if (!bankName || !bankCountry) {
      return res.status(400).json({ error: 'Missing bankName or bankCountry' });
    }

    const sessionRequest = {
      aspsp: {
        name: bankName,
        country: bankCountry
      },
      state: `ais_${Date.now()}`,
      redirect_url: REDIRECT_URL,
      access: {
        valid_until: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      }
    };

    const data = await enableBankingRequest('POST', '/auth', sessionRequest);

    res.json({
      success: true,
      authUrl: data.url,
      sessionId: data.session_id
    });
  } catch (error) {
    console.error('Error connecting bank:', error);
    res.status(500).json({ error: error.message });
  }
});

// OAuth callback handler
app.get('/callback', (req, res) => {
  const { code, state, error, error_description } = req.query;

  console.log('[Callback] Received callback:', { code: code ? 'present' : 'missing', state, error });

  if (error) {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Payment Failed - PayFlow</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
          }
          .container {
            text-align: center;
            padding: 40px;
            background: rgba(255,255,255,0.05);
            border-radius: 20px;
            backdrop-filter: blur(10px);
            max-width: 500px;
          }
          .icon { font-size: 64px; margin-bottom: 20px; }
          h1 { margin-bottom: 15px; color: #ff6b6b; }
          p { color: #a0a0a0; margin-bottom: 20px; }
          .error-detail {
            background: rgba(255,107,107,0.1);
            padding: 15px;
            border-radius: 10px;
            margin-bottom: 20px;
            color: #ff8888;
          }
          a {
            display: inline-block;
            padding: 12px 30px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-decoration: none;
            border-radius: 10px;
            font-weight: 500;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="icon">X</div>
          <h1>Payment Failed</h1>
          <p>Something went wrong during the authorization process.</p>
          <div class="error-detail">
            <strong>Error:</strong> ${error}<br>
            ${error_description ? `<strong>Details:</strong> ${error_description}` : ''}
          </div>
          <a href="/">Return to Dashboard</a>
        </div>
      </body>
      </html>
    `);
    return;
  }

  // Update payment status if we can find it
  if (state && state.startsWith('payment_')) {
    for (const [id, payment] of payments) {
      if (payment.id === state || id === state) {
        payment.status = 'authorized';
        payment.authCode = code;
        payments.set(id, payment);
        console.log('[Callback] Updated payment status to authorized:', id);
        break;
      }
    }
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Payment Authorized - PayFlow</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
        }
        .container {
          text-align: center;
          padding: 40px;
          background: rgba(255,255,255,0.05);
          border-radius: 20px;
          backdrop-filter: blur(10px);
          max-width: 500px;
        }
        .icon { font-size: 64px; margin-bottom: 20px; }
        h1 { margin-bottom: 15px; color: #00d4aa; }
        p { color: #a0a0a0; margin-bottom: 10px; }
        .state {
          background: rgba(0,212,170,0.1);
          padding: 15px;
          border-radius: 10px;
          margin: 20px 0;
          color: #00d4aa;
          word-break: break-all;
        }
        a {
          display: inline-block;
          padding: 12px 30px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          text-decoration: none;
          border-radius: 10px;
          font-weight: 500;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="icon">OK</div>
        <h1>Payment Authorized!</h1>
        <p>The bank authorization was successful.</p>
        ${state ? `<div class="state"><strong>Reference:</strong> ${state}</div>` : ''}
        ${code ? `<p style="color: #666; font-size: 12px;">Auth code received</p>` : ''}
        <a href="/">Return to Dashboard</a>
      </div>
    </body>
    </html>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log(`PayFlow server running on port ${PORT}`);
  console.log(`App ID: ${APP_ID ? APP_ID.substring(0, 8) + '...' : 'NOT SET'}`);
  console.log(`Private Key: ${PRIVATE_KEY ? 'LOADED' : 'NOT SET'}`);
  console.log(`Redirect URL: ${REDIRECT_URL}`);
});
