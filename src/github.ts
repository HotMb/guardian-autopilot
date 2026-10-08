import {createHmac, timingSafeEqual} from 'node:crypto';

export function verifyGitHubWebhookSignature(rawBody: string | Uint8Array, signatureHeader: string, webhookSecret: string): void {
  if (webhookSecret.trim() === '') throw new Error('GitHub webhook secret is required');
  if (!/^sha256=[a-f0-9]{64}$/i.test(signatureHeader)) throw new Error('GitHub webhook signature header is invalid');

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  const expected = createHmac('sha256', webhookSecret).update(body).digest('hex');
  const received = Buffer.from(signatureHeader.slice('sha256='.length), 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  if (!timingSafeEqual(expectedBytes, received)) throw new Error('GitHub webhook signature verification failed');
}
