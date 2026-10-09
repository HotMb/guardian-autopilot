import {sign, verify, type KeyObject} from 'node:crypto';

export type LicensePlan = 'pro' | 'team' | 'enterprise';

export type LicensePayload = {
  v: 1;
  plan: LicensePlan;
  seats: number;
  org: string;
  features: string[];
  iat: number;
  exp: number;
  kid: string;
};

export type LicenseIssueInput = Pick<LicensePayload, 'plan' | 'seats' | 'org' | 'features' | 'kid'> & {
  durationSeconds?: number;
};

type KeyMaterial = string | KeyObject | Buffer;

const DEFAULT_DURATION_SECONDS = 365 * 86_400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateInput(input: LicenseIssueInput): void {
  if (!['pro', 'team', 'enterprise'].includes(input.plan)) throw new Error('License plan is invalid');
  if (!Number.isSafeInteger(input.seats) || input.seats < 1) throw new Error('License seats must be a positive integer');
  if (typeof input.org !== 'string' || input.org.trim() === '') throw new Error('License organization is required');
  if (!Array.isArray(input.features) || input.features.some((feature) => typeof feature !== 'string' || feature.trim() === '')) throw new Error('License features are invalid');
  if (typeof input.kid !== 'string' || input.kid.trim() === '') throw new Error('License key id is required');
  if (input.durationSeconds !== undefined && (!Number.isSafeInteger(input.durationSeconds) || input.durationSeconds < 1)) throw new Error('License duration is invalid');
}

function payloadIsValid(value: unknown): value is LicensePayload {
  if (!isRecord(value)) return false;
  return value.v === 1
    && (value.plan === 'pro' || value.plan === 'team' || value.plan === 'enterprise')
    && typeof value.seats === 'number' && Number.isSafeInteger(value.seats) && value.seats >= 1
    && typeof value.org === 'string' && value.org.trim() !== ''
    && Array.isArray(value.features) && value.features.every((feature) => typeof feature === 'string' && feature.trim() !== '')
    && typeof value.iat === 'number' && Number.isSafeInteger(value.iat) && value.iat >= 0
    && typeof value.exp === 'number' && Number.isSafeInteger(value.exp) && value.exp > value.iat
    && typeof value.kid === 'string' && value.kid.trim() !== '';
}

function decodeBase64Url(value: string): Buffer | null {
  if (value === '' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.toString('base64url') === value ? decoded : null;
  } catch {
    return null;
  }
}

export function issueLicense(privateKey: KeyMaterial, input: LicenseIssueInput, nowSeconds = Math.floor(Date.now() / 1000)): string {
  validateInput(input);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) throw new Error('License issue time is invalid');
  const durationSeconds = input.durationSeconds ?? DEFAULT_DURATION_SECONDS;
  const payload: LicensePayload = {
    v: 1,
    plan: input.plan,
    seats: input.seats,
    org: input.org,
    features: [...input.features],
    iat: nowSeconds,
    exp: nowSeconds + durationSeconds,
    kid: input.kid,
  };
  const message = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign(null, message, privateKey);
  return `ccl_${message.toString('base64url')}.${signature.toString('base64url')}`;
}

export function verifyLicense(key: string, publicKey: KeyMaterial, nowSeconds = Math.floor(Date.now() / 1000)): LicensePayload | null {
  try {
    if (typeof key !== 'string' || !key.startsWith('ccl_') || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0) return null;
    const parts = key.slice(4).split('.');
    if (parts.length !== 2) return null;
    const message = decodeBase64Url(parts[0]);
    const signature = decodeBase64Url(parts[1]);
    if (message === null || signature === null || !verify(null, message, publicKey, signature)) return null;
    const payload: unknown = JSON.parse(message.toString('utf8'));
    if (!payloadIsValid(payload) || payload.exp <= nowSeconds) return null;
    return {...payload, features: [...payload.features]};
  } catch {
    return null;
  }
}
