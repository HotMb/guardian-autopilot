import {createHmac, createSign, timingSafeEqual} from 'node:crypto';

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

export function createGitHubAppJwt(appId: string | number, privateKey: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const normalizedAppId = String(appId);
  if (!/^\d+$/.test(normalizedAppId)) throw new Error('GitHub App id must be a positive integer');
  if (privateKey.trim() === '') throw new Error('GitHub App private key is required');
  if (!Number.isSafeInteger(nowSeconds)) throw new Error('JWT timestamp is invalid');

  const header = base64Url(JSON.stringify({alg: 'RS256', typ: 'JWT'}));
  const payload = base64Url(JSON.stringify({iat: nowSeconds - 60, exp: nowSeconds + 540, iss: normalizedAppId}));
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${base64Url(signer.sign(privateKey))}`;
}

export function verifyGitHubWebhookSignature(rawBody: string | Uint8Array, signatureHeader: string, webhookSecret: string): void {
  if (webhookSecret.trim() === '') throw new Error('GitHub webhook secret is required');
  if (!/^sha256=[a-f0-9]{64}$/i.test(signatureHeader)) throw new Error('GitHub webhook signature header is invalid');

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  const expected = createHmac('sha256', webhookSecret).update(body).digest('hex');
  const received = Buffer.from(signatureHeader.slice('sha256='.length), 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  if (!timingSafeEqual(expectedBytes, received)) throw new Error('GitHub webhook signature verification failed');
}
