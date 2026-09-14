import { createECDH, randomUUID } from 'node:crypto';
import { decode, encryptForDevice, verifyCertificate, base64 } from './crypto.js';

export function validateConfig(config) {
  for (const key of ['api_url', 'user_id', 'source_id', 'source_key', 'identity_public_key', 'sender_private_key']) {
    if (typeof config[key] !== 'string' || !config[key] || /[\r\n]/.test(config[key])) {
      throw new Error(`Missing or invalid config field: ${key}`);
    }
  }
  const url = new URL(config.api_url);
  if (url.username || url.password || url.search || url.hash) throw new Error('API URL must not contain credentials or query parameters');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('HTTPS is required except for loopback development');
  }
  decode(config.identity_public_key, 65);
  decode(config.sender_private_key, 32);
  return config;
}

async function api(config, path, options = {}, fetcher = fetch) {
  const response = await fetcher(new URL(path, config.api_url), {
    ...options, redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${config.source_key}`, 'content-type': 'application/json', ...options.headers },
  });
  if (!response.ok) throw new Error(`PushNow API rejected request (HTTP ${response.status})`);
  return response.json();
}

export async function recipients(config, fetcher = fetch) {
  validateConfig(config);
  const response = await api(config, '/v1/secure/recipients', {}, fetcher);
  if (response.user_id !== config.user_id || response.source_id !== config.source_id ||
      response.identity_public_key !== config.identity_public_key) {
    throw new Error('Account identity or source changed; refusing untrusted directory');
  }
  if (!await verifyCertificate(config.identity_public_key, 'source', config.user_id,
    config.source_id, response.source_public_key, response.source_certificate)) {
    throw new Error('Source certificate is invalid');
  }
  const senderKey = createECDH('prime256v1');
  senderKey.setPrivateKey(decode(config.sender_private_key, 32));
  const senderPublic = base64(senderKey.getPublicKey());
  if (senderPublic !== response.source_public_key) throw new Error('Sender private key does not match authorized source');
  if (!Array.isArray(response.devices) || response.devices.length > 1000) throw new Error('Invalid device directory');
  const ids = new Set();
  for (const device of response.devices) {
    if (ids.has(device.id) || device.user_id !== config.user_id || device.status !== 'active' ||
        !await verifyCertificate(config.identity_public_key, 'device', config.user_id, device.id, device.public_key, device.certificate)) {
      throw new Error('Untrusted or duplicate recipient device');
    }
    ids.add(device.id);
  }
  return response.devices;
}

export async function prepareMessage(config, devices, plaintext, options = {}) {
  if (typeof plaintext.title !== 'string' || typeof plaintext.body !== 'string') throw new Error('Message needs title and body');
  const now = Date.now();
  const expires = new Date(options.expiresAt ?? now + 24 * 60 * 60 * 1000);
  const scheduled = options.scheduledAt ? new Date(options.scheduledAt) : null;
  if (!Number.isFinite(+expires) || +expires <= now || +expires > now + 30 * 86400000 ||
      (scheduled && (!Number.isFinite(+scheduled) || +scheduled >= +expires))) {
    throw new Error('Invalid expiry or schedule (expiry must be within 30 days and after schedule)');
  }
  const selectedIDs = options.deviceIds ? new Set(options.deviceIds) : null;
  const selected = devices.filter((device) => selectedIDs ? selectedIDs.has(device.id) : device.notifications_enabled);
  if (selectedIDs && selected.length !== selectedIDs.size) throw new Error('Selected device is not an active authorized recipient');
  if (selected.length < 1 || selected.length > 32) throw new Error('Select between 1 and 32 authorized devices');
  const message_id = options.messageId ?? randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(message_id)) throw new Error('Message ID must be a UUID');
  const expires_at = expires.toISOString();
  const envelopes = [];
  for (const device of selected) {
    if (device.user_id !== config.user_id || device.status !== 'active' ||
        !await verifyCertificate(config.identity_public_key, 'device', config.user_id, device.id, device.public_key, device.certificate)) {
      throw new Error('Invalid recipient certificate');
    }
    envelopes.push(await encryptForDevice(config.sender_private_key, device.public_key,
      { user_id: config.user_id, source_id: config.source_id, device_id: device.id, message_id, expires_at }, plaintext));
  }
  return { message_id, expires_at, ...(scheduled ? { scheduled_at: scheduled.toISOString() } : {}), envelopes };
}

export async function submitMessage(config, message, fetcher = fetch) {
  return api(config, '/v1/secure/messages', {
    method: 'POST', headers: { 'idempotency-key': message.message_id }, body: JSON.stringify(message),
  }, fetcher);
}

