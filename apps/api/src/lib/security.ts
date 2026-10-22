import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export const newToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const hashIp = (ip: string | undefined) =>
  ip ? createHmac('sha256', config.IP_HASH_SECRET).update(ip).digest('hex').slice(0, 32) : null;

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
