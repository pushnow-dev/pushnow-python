import { createECDH, randomUUID } from 'node:crypto';
import { base64, decode, verifyCertificate } from './crypto.js';
import { authenticated } from './v2-http.js';
import { verifyArchive, sealV2, encryptAttachment } from './v2-crypto.js';

export async function recipientsV2(config, options = {}) {
  const directory = await authenticated(config, '/v2/recipients', options);
  if (directory.user_id !== config.user_id || directory.source_id !== config.source_id ||
      directory.identity_public_key !== config.identity_public_key) throw new Error('Account or source identity changed');
  if (!await verifyCertificate(config.identity_public_key, 'source', config.user_id, config.source_id,
    directory.source_public_key, directory.source_certificate)) throw new Error('Invalid source certificate');
  const key = createECDH('prime256v1'); key.setPrivateKey(decode(config.sender_private_key, 32));
  if (base64(key.getPublicKey()) !== directory.source_public_key) throw new Error('Sender key does not match source');
  await verifyArchive(config, directory.archive);
  if (!Array.isArray(directory.devices) || directory.devices.length > 1000) throw new Error('Invalid device directory');
  const ids = new Set();
  for (const d of directory.devices) {
    if (ids.has(d.id) || d.user_id !== config.user_id || d.status !== 'active' ||
        !await verifyCertificate(config.identity_public_key, 'device', config.user_id, d.id, d.public_key, d.certificate)) {
      throw new Error('Invalid device certificate');
    }
    ids.add(d.id);
  }
  return directory;
}

export async function uploadAttachment(config, data, metadata, options = {}) {
  const encrypted = await encryptAttachment(config, data, metadata);
  await authenticated(config, '/v2/attachments', { ...options, method: 'POST',
    body: { id: encrypted.descriptor.id, size: encrypted.ciphertext.length, read_token: encrypted.descriptor.read_token } });
  await authenticated(config, `/v2/attachments/${encodeURIComponent(encrypted.descriptor.id)}`, {
    ...options, method: 'PUT', binary: true, body: encrypted.ciphertext,
  });
  return encrypted.descriptor;
}

function truncateUTF8(value, limit) {
  let result = '', size = 0;
  for (const char of value) { const n = Buffer.byteLength(char); if (size + n > limit) break; result += char; size += n; }
  return result;
}

export function validateSound(sound) {
  if (sound !== undefined && !['default', 'silent', 'chime'].includes(sound)) {
    throw new Error('sound must be default, silent, or chime');
  }
}

export async function prepareMessageV2(config, directory, plaintext, { deviceIds, scheduledAt, expiresAt, sound, messageID = randomUUID() } = {}) {
  validateSound(sound);
  if (Object.hasOwn(plaintext, 'sound')) throw new Error('Pass sound as a routing option, not message content');
  await verifyArchive(config, directory.archive);
  if (typeof plaintext.title !== 'string' || typeof plaintext.body !== 'string') throw new Error('Message needs title and body');
  const full = { ...plaintext, links: plaintext.links ?? [], attachments: plaintext.attachments ?? [] };
  if (!Array.isArray(full.links) || full.links.some(link => typeof link !== 'string') ||
      !Array.isArray(full.attachments) || full.attachments.length > 20) throw new Error('Invalid links or attachment count');
  const attachmentIDs = full.attachments.map(a => a.id);
  if (new Set(attachmentIDs).size !== attachmentIDs.length) throw new Error('Duplicate attachment');
  for (const id of [full.image_id, full.icon_id].filter(Boolean)) {
    if (!attachmentIDs.includes(id)) throw new Error('Image and icon must refer to an attached file');
  }
  let notify;
  if (deviceIds !== undefined) {
    const requested = new Set(deviceIds);
    const selected = directory.devices.filter(d => requested.has(d.id));
    if (selected.length !== requested.size) throw new Error('Unknown or revoked notification device');
    notify = selected.filter(d => d.notifications_enabled).map(d => d.id);
  }
  const enc = await sealV2(config, directory.archive, 'message', messageID, full);
  if (decode(enc.ciphertext).length > 256 * 1024) throw new Error('Encrypted message manifest exceeds 256 KiB');
  let previewData = { title: truncateUTF8(full.title, 400), body: truncateUTF8(full.body, 700) };
  const image = full.attachments.find(a => a.id === full.image_id);
  if (image && Buffer.byteLength(JSON.stringify(image)) <= 600) previewData.image = image;
  let preview = await sealV2(config, directory.archive, 'preview', messageID, previewData);
  const previewSize = envelope => Buffer.byteLength(JSON.stringify({ aps: { alert: { title: 'PushNow', body: 'You have a new encrypted reminder.' }, 'mutable-content': 1,
    ...(sound === 'silent' ? {} : { sound: sound === 'chime' ? 'pushnow-chime.wav' : 'default' }) },
    secure_v2: { message_id: messageID, user_id: config.user_id, source_id: config.source_id,
      archive_id: directory.archive.id, device_id: '00000000-0000-0000-0000-000000000000', ...envelope,
      source_public_key: directory.source_public_key, source_certificate: directory.source_certificate,
      created_at: new Date().toISOString(), read_at: null } }));
  if (previewSize(preview) > 3900) {
    delete previewData.image;
    preview = await sealV2(config, directory.archive, 'preview', messageID, previewData);
  }
  if (previewSize(preview) > 3900) throw new Error('Encrypted preview is too large');
  return { message_id: messageID, archive_id: directory.archive.id, ...enc, preview,
    attachment_ids: attachmentIDs, ...(notify === undefined ? {} : { notify_device_ids: notify }),
    ...(scheduledAt === undefined ? {} : { scheduled_at: scheduledAt }),
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    ...(sound === undefined ? {} : { sound }) };
}

export async function submitMessageV2(config, message, options = {}) {
  validateSound(message.sound);
  return authenticated(config, '/v2/messages', { ...options, method: 'POST',
    headers: { 'idempotency-key': message.message_id }, body: message });
}
