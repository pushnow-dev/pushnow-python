import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { beginAccountLogin, beginLogin, finishAccountLogin, finishLogin } from './v2-auth.js';
import { fingerprint } from './v2-crypto.js';
import { decode } from './crypto.js';
import { recipientsV2, uploadAttachment, prepareMessageV2, submitMessageV2 } from './v2-client.js';

class InputError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const requireValue = (ok, code = 'INVALID_INPUT') => { if (!ok) throw new InputError(code); };
function pin(value) {
  requireValue(typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value), 'ROOT_PIN_REQUIRED');
  return value.toLowerCase();
}
function configFor(input) {
  const config = input.config;
  requireValue(config && config.archive, 'E2EE_CONFIG_REQUIRED');
  if (input.rootFingerprint !== undefined && input.rootFingerprint !== null && input.rootFingerprint !== '') {
    requireValue(fingerprint(config.identity_public_key) === pin(input.rootFingerprint), 'ROOT_PIN_MISMATCH');
  }
  return config;
}
function timestamp(value) {
  if (value === undefined) return undefined;
  requireValue(typeof value === 'string', 'INVALID_TIMESTAMP');
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  requireValue(m, 'INVALID_TIMESTAMP');
  const local = m[1] + 'T' + m[2] + ':' + m[3] + ':' + m[4] + '.' + (m[5] || '').padEnd(3, '0') + 'Z';
  const parsed = Date.parse(value), calendar = Date.parse(local);
  requireValue(Number.isFinite(parsed) && Number.isFinite(calendar) &&
    new Date(calendar).toISOString() === local, 'INVALID_TIMESTAMP');
  return new Date(parsed).toISOString();
}
function notification(value) {
  requireValue(value && typeof value === 'object');
  const allowed = ['title', 'body', 'links', 'files', 'images', 'icon', 'deviceIds', 'pushEnabled', 'scheduledAt', 'expiresAt', 'sound'];
  requireValue(Object.keys(value).every(k => allowed.includes(k)), 'UNSUPPORTED_OPTION');
  requireValue(value.sound === undefined || ['default', 'silent', 'chime'].includes(value.sound), 'INVALID_SOUND');
  const n = { ...value, body: value.body ?? '', links: value.links ?? [], files: value.files ?? [], images: value.images ?? [] };
  requireValue(typeof n.title === 'string' && typeof n.body === 'string');
  requireValue(Array.isArray(n.links) && n.links.every(v => typeof v === 'string'));
  requireValue(Array.isArray(n.files) && Array.isArray(n.images));
  requireValue(n.pushEnabled === undefined || typeof n.pushEnabled === 'boolean');
  requireValue(n.deviceIds === undefined || (Array.isArray(n.deviceIds) &&
    n.deviceIds.every(v => typeof v === 'string') && new Set(n.deviceIds).size === n.deviceIds.length));
  n.scheduledAt = timestamp(n.scheduledAt); n.expiresAt = timestamp(n.expiresAt);
  const now = Date.now(), maximum = now + 30 * 86400000;
  requireValue(n.scheduledAt === undefined || (Date.parse(n.scheduledAt) > now && Date.parse(n.scheduledAt) <= maximum), 'INVALID_SCHEDULE');
  requireValue(n.expiresAt === undefined || (Date.parse(n.expiresAt) > (n.scheduledAt ? Date.parse(n.scheduledAt) : now) &&
    Date.parse(n.expiresAt) <= maximum), 'INVALID_EXPIRY');
  requireValue(n.files.length + n.images.length + (n.icon ? 1 : 0) <= 20, 'TOO_MANY_ATTACHMENTS');
  return n;
}
async function fileData(file, image) {
  requireValue(file && typeof file === 'object');
  requireValue((typeof file.path === 'string') !== (typeof file.dataBase64 === 'string'), 'FILE_INPUT_REQUIRED');
  const name = file.name ?? (file.path ? basename(file.path) : undefined);
  const mime = file.mime ?? 'application/octet-stream';
  requireValue(typeof name === 'string' && name.length > 0 && typeof mime === 'string');
  requireValue(!image || mime.startsWith('image/'), 'IMAGE_MIME_REQUIRED');
  let data;
  if (file.path) {
    const info = await stat(file.path);
    requireValue(info.isFile() && info.size <= 20 * 1024 * 1024 - 16, 'FILE_TOO_LARGE');
    data = await readFile(file.path);
  } else {
    requireValue(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.dataBase64), 'INVALID_FILE_BASE64');
    data = Buffer.from(file.dataBase64, 'base64');
  }
  requireValue(data.length <= 20 * 1024 * 1024 - 16, 'FILE_TOO_LARGE');
  return { data, name, mime };
}
// Log fixed route labels only, never credentials, content, query strings, IDs or paths.
function fetchOptions(logs) {
  return { fetcher: async (url, options) => {
    const route = url.pathname.replace(/(\/attachments|\/authorizations)\/[^/]+/, '$1/:id');
    const start = performance.now();
    try {
      const response = await fetch(url, options);
      logs.push({ method: options.method, route, status: response.status, elapsedMs: Math.round(performance.now() - start) });
      return response;
    } catch {
      logs.push({ method: options.method, route, status: 0, elapsedMs: Math.round(performance.now() - start) });
      throw new InputError('NETWORK_ERROR');
    }
  } };
}
export async function execute(input) {
  const logs = [];
  try {
    const options = fetchOptions(logs);
    let data;
    if (input.operation === 'beginAuthorization') {
      pin(input.rootFingerprint);
      const pending = await beginLogin(input.apiURL, input.name, options);
      data = { ...pending, expectedRootFingerprint: pin(input.rootFingerprint) };
    } else if (input.operation === 'beginAccountAuthorization') {
      const pending = await beginAccountLogin(input.apiURL, input.accessToken, input.name, options);
      data = pending;
    } else if (input.operation === 'finishAuthorization') {
      const expected = pin(input.rootFingerprint);
      requireValue(input.pending?.expectedRootFingerprint === expected, 'ROOT_PIN_MISMATCH');
      data = await finishLogin(input.pending, { ...options, expectedIdentityFingerprint: expected });
      // Check source key binding and every recipient certificate before returning credentials.
      await recipientsV2(data, options);
    } else if (input.operation === 'finishAccountAuthorization') {
      data = await finishAccountLogin(input.pending, options);
      await recipientsV2(data, options);
    } else {
      const config = configFor(input);
      if (input.operation === 'recipients') data = await recipientsV2(config, options);
      else if (input.operation === 'retry') {
        const envelope = input.envelope;
        requireValue(envelope && typeof envelope.message_id === 'string' && envelope.archive_id === config.archive.id, 'INVALID_OUTBOX');
        const allowed = ['message_id', 'archive_id', 'enc', 'ciphertext', 'preview', 'attachment_ids', 'notify_device_ids', 'scheduled_at', 'expires_at', 'sound'];
        requireValue(envelope.sound === undefined || ['default', 'silent', 'chime'].includes(envelope.sound), 'INVALID_SOUND');
        requireValue(Object.keys(envelope).every(k => allowed.includes(k)) &&
          typeof envelope.enc === 'string' && typeof envelope.ciphertext === 'string' &&
          envelope.preview && typeof envelope.preview.enc === 'string' && typeof envelope.preview.ciphertext === 'string', 'INVALID_OUTBOX');
        requireValue(Object.keys(envelope.preview).every(k => ['enc', 'ciphertext'].includes(k)), 'INVALID_OUTBOX');
        decode(envelope.enc, 65); decode(envelope.preview.enc, 65);
        requireValue(decode(envelope.ciphertext).length >= 16 && decode(envelope.preview.ciphertext).length >= 16, 'INVALID_OUTBOX');
        await recipientsV2(config, options);
        data = await submitMessageV2(config, envelope, options);
      } else if (input.operation === 'prepare' || input.operation === 'send') {
        const n = notification(input.notification);
        const directory = await recipientsV2(config, options);
        if (n.deviceIds !== undefined) requireValue(n.deviceIds.every(id => directory.devices.some(d => d.id === id)), 'UNKNOWN_DEVICE');
        const uploads = [];
        for (const file of n.files) uploads.push({ ...await fileData(file, false) });
        for (const file of n.images) uploads.push({ ...await fileData(file, true), role: 'image_id' });
        if (n.icon) uploads.push({ ...await fileData(n.icon, true), role: 'icon_id' });
        const full = { title: n.title, body: n.body, links: n.links, attachments: [] };
        for (const upload of uploads) {
          const descriptor = await uploadAttachment(config, upload.data, { name: upload.name, mime: upload.mime }, options);
          full.attachments.push(descriptor);
          if (upload.role && !full[upload.role]) full[upload.role] = descriptor.id;
        }
        data = await prepareMessageV2(config, directory, full, {
          deviceIds: n.pushEnabled === false ? [] : n.deviceIds, scheduledAt: n.scheduledAt, expiresAt: n.expiresAt, sound: n.sound,
        });
        if (input.operation === 'send') data = { envelope: data, result: await submitMessageV2(config, data, options) };
      } else throw new InputError('UNKNOWN_OPERATION');
    }
    return { ok: true, data, logs };
  } catch (error) {
    return { ok: false, error: { code: error instanceof InputError ? error.code :
      Number.isInteger(error.status) ? 'HTTP_' + error.status : 'E2EE_REQUEST_FAILED' }, logs };
  }
}
