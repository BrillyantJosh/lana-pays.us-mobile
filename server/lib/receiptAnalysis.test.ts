// @vitest-environment node
/**
 * The receipt route's reader, without the network. Before this module the
 * model's invoice number went to the till verbatim — a bank account or a VAT
 * id became the shop's "invoice number" and blocked its next receipts.
 */
import { describe, it, expect, vi } from 'vitest';
import { analyzeReceiptImage, parseAnalysisText, receiptPrompt } from './receiptAnalysis';

const modelSays = (body: object) =>
  vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(body) }] }), { status: 200 }));

const read = (fetchImpl: any) => analyzeReceiptImage({
  buffer: Buffer.from('not really a jpeg'),
  mediaType: 'image/jpeg',
  currency: 'EUR',
  lang: 'sl',
  apiKey: 'test-key-not-real',
  fetchImpl,
  sleep: async () => {},
});

describe('analyzeReceiptImage', () => {
  it('a bank account read as the invoice number comes back as null', async () => {
    const out = await read(modelSays({ isReceipt: true, amount: 191.33, currency: 'EUR', invoiceNumber: 'SI56 1234 5678 9012 345', items: 'x' }));
    expect(out.isReceipt).toBe(true);
    expect(out.amount).toBe(191.33);
    expect(out.invoiceNumber).toBeNull();
  });

  it('a real number passes unchanged', async () => {
    const out = await read(modelSays({ isReceipt: true, amount: 9.1, currency: 'EUR', invoiceNumber: 'TRG1-L0001-52160', items: 'x' }));
    expect(out.invoiceNumber).toBe('TRG1-L0001-52160');
  });

  it('the prompt sent carries the wrap rule, the label rule and the language', async () => {
    const fetchImpl = modelSays({ isReceipt: false, description: 'd', amount: null, invoiceNumber: null });
    await read(fetchImpl);
    const body = JSON.parse((fetchImpl.mock.calls[0] as any)[1].body);
    const text = body.messages[0].content[1].text as string;
    expect(text).toContain('WRAP');
    expect(text).toContain('RAČUN št.');
    expect(text).toContain('Slovenian');
    expect(body.model).toBe('claude-haiku-4-5-20251001');
  });

  it('overloaded on every try → analysisError overloaded, as before', async () => {
    const fetchImpl = vi.fn(async () => new Response('busy', { status: 529 }));
    const out = await read(fetchImpl);
    expect(out).toEqual({ isReceipt: false, description: '', amount: null, invoiceNumber: null, analysisError: 'overloaded' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('a 400 is not retried → analysisError failed', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 400 }));
    const out = await read(fetchImpl);
    expect(out.analysisError).toBe('failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('parseAnalysisText', () => {
  it('markdown-wrapped JSON still parses, and the number is checked', () => {
    const out = parseAnalysisText('```json\n{"isReceipt":true,"amount":5,"invoiceNumber":"L0001","items":"a"}\n```');
    expect(out.isReceipt).toBe(true);
    expect(out.invoiceNumber).toBeNull();
  });
  it('text that is not JSON becomes a non-receipt description', () => {
    const out = parseAnalysisText('I cannot read this');
    expect(out).toEqual({ isReceipt: false, description: 'I cannot read this', amount: null, invoiceNumber: null });
  });
});

describe('receiptPrompt', () => {
  it('keeps the two answer shapes the app parses', () => {
    const p = receiptPrompt('EUR', 'Slovenian');
    expect(p).toContain('{"isReceipt":true,"amount":NUMBER_OR_NULL,"currency":"EUR","invoiceNumber":"STRING_OR_NULL"');
    expect(p).toContain('{"isReceipt":false,"description"');
  });
});
