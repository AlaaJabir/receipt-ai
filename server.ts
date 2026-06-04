import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = 3000;

// Initialize Supabase client lazily
let supabase: ReturnType<typeof createClient> | null = null;
function getSupabase() {
  if (!supabase) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be defined in the environment.');
    }
    supabase = createClient(supabaseUrl, supabaseKey);
  }
  return supabase;
}

// Initialize Gemini client lazily
let ai: GoogleGenAI | null = null;
function getAI() {
  if (!ai) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY must be defined in the environment.');
    }
    ai = new GoogleGenAI({ apiKey });
  }
  return ai;
}

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/receipts', async (req, res) => {
  try {
    const client = getSupabase();
    const { data, error } = await client
      .from('receipts')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ receipts: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/receipts/process', async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body;
    if (!imageBase64 || !mimeType) {
      return res.status(400).json({ error: 'Image data and mimeType are required' });
    }

    const aiClient = getAI();

    let response;
    let retries = 3;
    while (retries > 0) {
      try {
        response = await aiClient.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    role: 'user',
                    parts: [
                        {
                            text: `Analyze this receipt. Extract the following information and output it as a JSON object:
merchant: name of the store/merchant
date: transaction date (e.g., 'Oct 26, 2023')
category: inferred category (e.g., 'Transportation', 'Software', 'Meals')
total: total amount as a number
currency: currency abbreviation (e.g., 'USD', 'MAD', 'DH', 'EUR')
ht: amount before tax (HT) as a number, if explicitly shown. Otherwise null.
tva: total tax (TVA) as a number, if explicitly shown. Otherwise null.
insight: a short 1-2 sentence AI insight about this expense (e.g., noting if it's high, unusual, or normal).

Return ONLY valid JSON without markdown wrapping.`
                        },
                        {
                            inlineData: {
                                data: imageBase64,
                                mimeType
                            }
                        }
                    ]
                }
            ]
        });
        break; // Sucess, exit loop
      } catch (err: any) {
        retries--;
        if (retries === 0) throw err;
        await new Promise(res => setTimeout(res, 2000)); // wait 2 seconds before retry
      }
    }

    const aiText = response?.text || '';
    let parsedData;
    try {
        const cleanedText = aiText.replace(/```json/g, '').replace(/```/g, '').trim();
        parsedData = JSON.parse(cleanedText);
    } catch (e) {
        return res.status(500).json({ error: 'Failed to parse AI response as JSON', rawText: aiText });
    }

    // Save to Supabase
    const client = getSupabase();
    const { data, error } = await client
      .from('receipts')
      .insert([{
          merchant: parsedData.merchant,
          date: parsedData.date,
          category: parsedData.category,
          total: parsedData.total,
          currency: parsedData.currency,
          ht: parsedData.ht || null,
          tva: parsedData.tva || null,
          insight: parsedData.insight,
          status: 'Pending Approval'
      }] as any)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to save to Supabase: ' + error.message });
    }

    res.json({ receipt: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
