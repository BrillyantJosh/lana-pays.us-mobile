/**
 * Receipt reading (Claude Vision) for POST /api/receipt/analyze.
 *
 * Lives here, not inline in the route, so the exact prompt and the checks on
 * its answer can be tested — and run on a stored receipt — without starting
 * the server. The route keeps its own input handling and passes the key in.
 */
import { INVOICE_NUMBER_RULES, sanitizeInvoiceNumber } from './invoiceNumber.js';

export const RECEIPT_MODEL = 'claude-haiku-4-5-20251001';
export const MAX_IMAGE_BYTES = 3_500_000; // 3.5 MB raw → ~4.7 MB base64 (under Claude's 5 MB limit)

/** The seller's UI language, spelled out so the model is unambiguous. */
const LANG_NAMES: Record<string, string> = {
  en: 'English', sl: 'Slovenian', de: 'German', it: 'Italian', es: 'Spanish',
  pt: 'Portuguese', hr: 'Croatian', sr: 'Serbian', pl: 'Polish',
  hu: 'Hungarian', ru: 'Russian', zh: 'Chinese',
};

export function languageName(lang: string | undefined): string {
  const code = (lang || 'en').slice(0, 2).toLowerCase();
  return LANG_NAMES[code] || 'English';
}

export function receiptPrompt(currency: string, langName: string): string {
  return `Analyze this image. Respond ONLY with valid JSON (no markdown, no code blocks).

If this is a receipt/invoice/bill:
{"isReceipt":true,"amount":NUMBER_OR_NULL,"currency":"${currency}","invoiceNumber":"STRING_OR_NULL","items":"brief description of purchased items"}

If this is NOT a receipt (photo of people, items, scene, etc.):
{"isReceipt":false,"description":"what the image shows in 1-2 sentences","amount":null,"invoiceNumber":null}

Rules:
- amount must be a number (no currency symbols), or null if unreadable
${INVOICE_NUMBER_RULES}
- For non-receipts, describe what you see objectively
- IMPORTANT: write the "items" and "description" text in ${langName}. All other JSON keys and values stay exactly as specified.`;
}

/** The model's text → the analysis object, with the invoice number checked. */
export function parseAnalysisText(text: string): any {
  let analysis: any;
  try {
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    analysis = JSON.parse(jsonStr);
  } catch {
    console.warn('[mobile] Failed to parse Claude response:', text);
    analysis = { isReceipt: false, description: text.slice(0, 200), amount: null, invoiceNumber: null };
  }
  if (!analysis || typeof analysis !== 'object') {
    return { isReceipt: false, description: '', amount: null, invoiceNumber: null };
  }
  analysis.invoiceNumber = sanitizeInvoiceNumber(analysis.invoiceNumber);
  return analysis;
}

export interface AnalyzeInput {
  buffer: Buffer;
  mediaType: string;
  currency?: string;
  lang?: string;
  apiKey: string;
  /** For tests. */
  fetchImpl?: typeof fetch;
  /** For tests: no real waiting between retries. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Read one receipt image. Same answer shapes the route always returned,
 * including { analysisError: 'overloaded' | 'failed' } when the model could
 * not be reached. Throws only on unexpected errors (the route maps those).
 */
export async function analyzeReceiptImage(input: AnalyzeInput): Promise<any> {
  const doFetch = input.fetchImpl || fetch;
  const sleep = input.sleep || ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let imageBuffer = input.buffer;
  let mediaType = input.mediaType;
  const currency = input.currency || 'EUR';
  const langName = languageName(input.lang);

  // Resize if image exceeds Claude's 5 MB base64 limit
  if (imageBuffer.length > MAX_IMAGE_BYTES) {
    console.log(`[mobile] Receipt image too large (${(imageBuffer.length / 1024 / 1024).toFixed(1)} MB), resizing...`);
    const { default: sharp } = await import('sharp');
    imageBuffer = await sharp(imageBuffer)
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    mediaType = 'image/jpeg';
    console.log(`[mobile] Resized to ${(imageBuffer.length / 1024 / 1024).toFixed(1)} MB`);
  }

  const requestBody = JSON.stringify({
    model: RECEIPT_MODEL,
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBuffer.toString('base64') } },
        { type: 'text', text: receiptPrompt(currency, langName) },
      ],
    }],
  });

  // Retry on transient Anthropic errors: 429 (rate-limited), 5xx, 529 (overloaded).
  // Backoff: 500 ms → 1500 ms → 3500 ms (max 3 attempts, total <6 s).
  const RETRY_DELAYS_MS = [500, 1500, 3500];
  let response: Response | null = null;
  let lastStatus = 0;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const r = await doFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': input.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: requestBody,
    });

    if (r.ok) { response = r; break; }

    lastStatus = r.status;
    const lastErrText = await r.text();
    const transient = r.status === 429 || r.status === 529 || (r.status >= 500 && r.status < 600);

    if (!transient || attempt === RETRY_DELAYS_MS.length) {
      // Non-retryable, or out of retries
      console.error(`[mobile] Claude Vision error (attempt ${attempt + 1}):`, r.status, lastErrText);
      break;
    }

    console.warn(`[mobile] Claude Vision transient ${r.status}, retrying in ${RETRY_DELAYS_MS[attempt]}ms (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1})`);
    await sleep(RETRY_DELAYS_MS[attempt]);
  }

  if (!response) {
    // All attempts failed — signal the reason so the client can show a sensible message.
    const overloaded = lastStatus === 429 || lastStatus === 529 || (lastStatus >= 500 && lastStatus < 600);
    return {
      isReceipt: false,
      description: '',
      amount: null,
      invoiceNumber: null,
      analysisError: overloaded ? 'overloaded' : 'failed',
    };
  }

  const result: any = await response.json();
  const text = result?.content?.[0]?.text || '{}';
  return parseAnalysisText(text);
}
