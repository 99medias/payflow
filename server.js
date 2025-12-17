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

// Middleware
app.use(cors({
  origin: FRONTEND_URL === '*' ? true : FRONTEND_URL,
  credentials: true
}));
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
  }

  const response = await fetch(`${API_BASE_URL}${path}`, options);

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Enable Banking API error: ${response.status} - ${errorText}`);
    throw new Error(`API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

// Routes

// Health check for Railway
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// API info
app.get('/', (req, res) => {
  res.json({
    name: 'PayFlow Open Banking Server',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: 'GET /health',
      banks: 'GET /api/banks/:country',
      payments: 'GET /api/payments',
      createPayment: 'POST /api/payments',
      paymentStatus: 'GET /api/payments/:id',
      connect: 'POST /api/connect',
      callback: 'GET /callback'
    }
  });
});

// List available banks for a country
app.get('/api/banks/:country', async (req, res) => {
  try {
    const { country } = req.params;
    const data = await enableBankingRequest('GET', `/aspsps?country=${country.toUpperCase()}`);
    res.json(data);
  } catch (error) {
    console.error('Error fetching banks:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create a payment
app.post('/api/payments', async (req, res) => {
  try {
    const { amount, creditorIban, creditorName, reference, bankName, bankCountry } = req.body;

    if (!amount || !creditorIban || !creditorName || !bankName || !bankCountry) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Create payment session with Enable Banking
    const paymentRequest = {
      aspsp: {
        name: bankName,
        country: bankCountry
      },
      state: `payment_${Date.now()}`,
      redirect_url: REDIRECT_URL,
      payment_request: {
        credit_transfer_payment: [{
          instruction_id: `INS${Date.now()}`,
          end_to_end_id: `E2E${Date.now()}`,
          creditor: {
            name: creditorName
          },
          creditor_account: {
            iban: creditorIban
          },
          instructed_amount: {
            currency: 'EUR',
            amount: amount.toString()
          },
          remittance_information_unstructured: reference || 'Payment'
        }]
      }
    };

    const data = await enableBankingRequest('POST', '/pis/sessions', paymentRequest);

    // Store payment in memory
    const paymentId = data.payment_id || paymentRequest.state;
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

    res.json({
      success: true,
      paymentId,
      authUrl: data.url,
      payment
    });
  } catch (error) {
    console.error('Error creating payment:', error);
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
        const data = await enableBankingRequest('GET', `/pis/sessions/${payment.sessionId}`);
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
          <div class="icon">❌</div>
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
        <div class="icon">✅</div>
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
