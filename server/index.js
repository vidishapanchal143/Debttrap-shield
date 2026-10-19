/**
 * DebtTrap Shield — Express server
 * Proxies Gemini API calls so the API key never reaches the browser.
 * All final calculations are done client-side in deterministic JS.
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 3002;

// In-memory upload only — never written to disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and WebP images are accepted.'));
    }
  }
});

app.use(cors());
app.use(express.json());

// Serve static frontend files in production
const frontendDist = path.join(__dirname, '../frontend/dist');
app.use(express.static(frontendDist));

// Health check
app.get('/api/health', (req, res) => {
  const hasKey = !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
  res.json({ ok: true, geminiConfigured: hasKey });
});

/**
 * POST /api/gemini/extract
 * Accepts: multipart/form-data with field "image"
 * Returns: JSON with extracted loan fields (all final math stays client-side)
 */
app.post('/api/gemini/extract', upload.single('image'), async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim();
  const model = (process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();

  if (!apiKey) {
    return res.status(503).json({
      error: 'no_key',
      message: 'Gemini API key is not configured on this server. Use manual entry.'
    });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'no_image', message: 'No image uploaded.' });
  }

  const imageBase64 = req.file.buffer.toString('base64');
  const mimeType = req.file.mimetype;

  const prompt = `You are a loan document reader. Extract ONLY the following fields from this loan offer image.
Return a JSON object with exactly these fields (use null for any field you cannot find or are uncertain about):
{
  "amountReceived": number or null,
  "totalRepayment": number or null,
  "tenureDays": number or null,
  "interest": number or null,
  "fees": number or null,
  "paymentCount": number or null,
  "sourceText": "exact text you found these values in, max 300 chars",
  "confidence": "high" | "medium" | "low",
  "unknownFields": ["list of fields you could not determine"]
}

Rules:
- All amounts are in INR (Indian Rupees). Do NOT include currency symbols in numbers.
- Do NOT calculate or invent missing values.
- Do NOT include personal identifiers (name, phone, Aadhaar, account number, address, OTP, password).
- If you cannot read the image clearly, set confidence to "low" and return nulls.
- Return ONLY the JSON object. No extra text.`;

  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const geminiModel = genAI.getGenerativeModel({ model });

    const result = await geminiModel.generateContent([
      { inlineData: { data: imageBase64, mimeType } },
      prompt
    ]);

    const rawText = result.response.text().trim();

    // Strip markdown code fences if present
    let jsonText = rawText;
    const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonText = fenceMatch[1].trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return res.status(422).json({
        error: 'parse_error',
        message: 'Gemini returned an unexpected format. Please enter values manually.',
        rawText: rawText.slice(0, 300)
      });
    }

    // Validate and sanitize: strip any personal-looking fields
    const safe = {
      amountReceived: typeof parsed.amountReceived === 'number' ? parsed.amountReceived : null,
      totalRepayment: typeof parsed.totalRepayment === 'number' ? parsed.totalRepayment : null,
      tenureDays: typeof parsed.tenureDays === 'number' ? parsed.tenureDays : null,
      interest: typeof parsed.interest === 'number' ? parsed.interest : null,
      fees: typeof parsed.fees === 'number' ? parsed.fees : null,
      paymentCount: typeof parsed.paymentCount === 'number' ? parsed.paymentCount : null,
      sourceText: typeof parsed.sourceText === 'string' ? parsed.sourceText.slice(0, 300) : null,
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
      unknownFields: Array.isArray(parsed.unknownFields) ? parsed.unknownFields : []
    };

    return res.json({ success: true, extracted: safe });
  } catch (err) {
    console.error('[Gemini extract] error:', err.message);

    if (err.message && err.message.includes('429')) {
      return res.status(429).json({
        error: 'quota_exceeded',
        message: 'Gemini free-tier quota reached. Please try again later or enter values manually.'
      });
    }
    if (err.message && (err.message.includes('401') || err.message.includes('API_KEY'))) {
      return res.status(401).json({
        error: 'invalid_key',
        message: 'Gemini API key is invalid or expired. Enter values manually.'
      });
    }

    return res.status(502).json({
      error: 'gemini_error',
      message: 'Gemini service is unavailable. Please enter values manually.'
    });
  }
});

// SPA fallback: any non-API route serves index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(frontendDist, 'index.html'));
});

app.listen(PORT, () => {
  const hasKey = !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
  console.log(`DebtTrap Shield server running at http://localhost:${PORT}`);
  console.log(`Gemini API key: ${hasKey ? 'configured' : 'NOT configured (Gemini features disabled)'}`);
});
