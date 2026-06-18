import crypto from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToBuffer(base32) {
  const cleaned = base32.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const output = [];

  for (let i = 0; i < cleaned.length; i++) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(cleaned[i]);
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function generateBase32Secret(length = 32) {
  const bytes = crypto.randomBytes(length);
  let secret = '';
  for (let i = 0; i < bytes.length; i++) {
    secret += BASE32_ALPHABET[bytes[i] & 31];
  }
  return secret;
}

function computeHotpValue(secret, counter, digits = 6) {
  const key = base32ToBuffer(secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binary % Math.pow(10, digits);
  return otp.toString().padStart(digits, '0');
}

function generateTotpCode(secret, period = 30, digits = 6) {
  const counter = Math.floor(Date.now() / 1000 / period);
  return computeHotpValue(secret, counter, digits);
}

function verifyTotpCode(code, secret, period = 30, window = 1) {
  if (!code || !secret) return false;
  for (let i = -window; i <= window; i++) {
    const now = Date.now();
    const adjustedTime = now + i * period * 1000;
    const counter = Math.floor(adjustedTime / 1000 / period);
    const computedCode = computeHotpValue(secret, counter, 6);
    if (computedCode === code) return true;
  }
  return false;
}

function generateTotpUri(email, secret, issuer = 'Transcripta') {
  const encodedIssuer = encodeURIComponent(issuer);
  const encodedEmail = encodeURIComponent(email);
  return `otpauth://totp/${encodedIssuer}:${encodedEmail}?secret=${secret}&issuer=${encodedIssuer}`;
}

export { generateBase32Secret, verifyTotpCode, generateTotpUri };
