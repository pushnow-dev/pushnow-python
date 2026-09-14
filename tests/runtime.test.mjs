import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createECDH, randomUUID, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { suite, bytes, base64, decode, certificateText } from '../runtime/crypto.js';
import { v2AAD, fingerprint } from '../runtime/v2-crypto.js';
import { execute } from '../runtime/bridge.js';

const vector = JSON.parse(await readFile(new URL('./cli-vector.json', import.meta.url), 'utf8'));
const f = vector.fixture;
async function open(envelope, purpose = 'message', config = f.config) {
  const value = purpose === 'preview' ? envelope.preview : envelope;
  const recipient = await suite.createRecipientContext({
    recipientKey: await suite.kem.deserializePrivateKey(decode(f.archiveKey.privateKey)),
    senderPublicKey: await suite.kem.deserializePublicKey(decode(f.directory.source_public_key)),
    enc: decode(value.enc), info: bytes('pushnow-v2'),
  });
  return JSON.parse(Buffer.from(await recipient.open(decode(value.ciphertext),
    v2AAD(purpose, config, envelope.message_id, envelope.archive_id))).toString('utf8'));
}
async function sign(kind, id, publicKey) {
  const ec = createECDH('prime256v1'); ec.setPrivateKey(decode(f.identityPrivateKey)); const pub = ec.getPublicKey();
  const key = await webcrypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256',
    d: decode(f.identityPrivateKey).toString('base64url'),
    x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return base64(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key,
    bytes(certificateText(kind, f.config.user_id, id, publicKey))));
}
test('decrypts actual CLI-produced HPKE Auth vector; rejects tampering and wrong account AAD', async () => {
  assert.deepEqual(await open(vector.envelope), vector.plaintext);
  const altered = { ...vector.envelope, ciphertext: base64(Buffer.alloc(decode(vector.envelope.ciphertext).length)) };
  await assert.rejects(open(altered));
  await assert.rejects(open({ ...vector.envelope, message_id: randomUUID() }));
  await assert.rejects(open(vector.envelope, 'message', { ...f.config, user_id: randomUUID() }));
  await assert.rejects(open(vector.envelope, 'message', { ...f.config, source_id: randomUUID() }));
});
test('rejects token-only config, missing root pin and invalid sound before upload', async () => {
  const rootFingerprint = fingerprint(f.config.identity_public_key);
  const token = await execute({ operation: 'recipients', rootFingerprint, config: { source_key: 'secret' } });
  assert.equal(token.error.code, 'E2EE_CONFIG_REQUIRED'); assert.deepEqual(token.logs, []);
  const unpinned = await execute({ operation: 'recipients', config: f.config });
  assert.equal(unpinned.error.code, 'ROOT_PIN_REQUIRED');
  const wrong = await execute({ operation: 'recipients', config: f.config, rootFingerprint: '0'.repeat(64) });
  assert.equal(wrong.error.code, 'ROOT_PIN_MISMATCH');
  for (const value of [null, '', 'custom', 'pushnow-chime.wav', {}, false]) {
    const sound = await execute({ operation: 'prepare', rootFingerprint, config: f.config,
      notification: { title: 'Hi', sound: value, files: [{ path: '/must-not-be-read' }] } });
    assert.equal(sound.error.code, 'INVALID_SOUND'); assert.deepEqual(sound.logs, []);
  }
  const invalid = await execute({ operation: 'prepare', rootFingerprint, config: f.config, notification: { title: 'Hi', scheduledAt: '2030-02-30T10:00:00Z' } });
  assert.equal(invalid.error.code, 'INVALID_TIMESTAMP');
});

test('language binding authorizes against pinned root and sends real HTTP E2EE requests', { timeout: 180000 }, async () => {
  const uploads = new Map(), messages = new Map(), pending = new Map();
  const originalSourcePublic = f.directory.source_public_key;
  let origin, failure, failures = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const data = Buffer.concat(chunks), url = new URL(req.url, origin);
      const json = data.length && req.headers['content-type'] !== 'application/octet-stream' ? JSON.parse(data) : undefined;
      const send = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/v2/authorizations' && req.method === 'POST') {
        const id = randomUUID(); pending.set(id, json.public_key);
        return send({ id, user_code: 'TEST2345', device_code: 'test-device-code', expires_at: new Date(Date.now() + 120000).toISOString(), interval: 3 });
      }
      if (/^\/v2\/authorizations\/[^/]+\/token$/.test(url.pathname)) {
        const id = url.pathname.split('/')[3], publicKey = pending.get(id);
        assert.ok(publicKey); assert.equal(json.device_code, 'test-device-code');
        f.directory.source_public_key = publicKey;
        f.directory.source_certificate = await sign('source', f.config.source_id, publicKey);
        const sender = await suite.createSenderContext({
          recipientPublicKey: await suite.kem.deserializePublicKey(decode(publicKey)),
          info: bytes('pushnow-sender-grant-v2'),
        });
        const { sender_private_key, ...config } = f.config;
        const grant = { enc: base64(sender.enc), ciphertext: base64(await sender.seal(bytes(JSON.stringify({ ...config, api_url: origin })),
          bytes(JSON.stringify([2, 'sender-grant', id, publicKey])))) };
        return send({ status: 'approved', grant });
      }
      assert.equal(req.headers.authorization, 'Bearer ' + f.config.source_key);
      if (failure) return send({ error: 'secret-server-content-do-not-log' }, 503);
      if (url.pathname === '/v2/recipients') return send(f.directory);
      if (url.pathname === '/v2/attachments' && req.method === 'POST') {
        assert.deepEqual(Object.keys(json).sort(), ['id', 'read_token', 'size']);
        uploads.set(json.id, { size: json.size }); return send({});
      }
      if (url.pathname.startsWith('/v2/attachments/') && req.method === 'PUT') {
        const upload = uploads.get(url.pathname.split('/')[3]); assert.ok(upload);
        assert.equal(data.length, upload.size); upload.data = data; res.writeHead(204); return res.end();
      }
      if (url.pathname === '/v2/messages') {
        assert.equal(req.headers['idempotency-key'], json.message_id);
        assert.ok(!data.includes(Buffer.from('Sensitive fixture')));
        const duplicate = messages.has(json.message_id);
        if (duplicate) {
          try { assert.deepEqual(json, messages.get(json.message_id)); }
          catch { return send({ code: 'message_id_conflict' }, 409); }
        }
        messages.set(json.message_id, json);
        return send({ message_id: json.message_id, deduplicated: duplicate }, duplicate ? 200 : 201);
      }
      send({}, 404);
    } catch (error) { failures.push(error); res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  const rootFingerprint = fingerprint(f.config.identity_public_key);
  const notification = { title: 'Sensitive fixture title', body: 'Sensitive fixture body',
    links: ['https://example.com/guide'], pushEnabled: false, sound: 'chime',
    scheduledAt: new Date(Date.now() + 300000).toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
    files: [{ dataBase64: base64(bytes('Sensitive fixture file')), name: 'private.txt', mime: 'text/plain' }],
    images: [{ dataBase64: base64(bytes('image fixture bytes')), name: 'image.png', mime: 'image/png' }],
    icon: { dataBase64: base64(bytes('icon fixture bytes')), name: 'icon.png', mime: 'image/png' } };
  try {
    const command = ['python3', 'tests/probe.py'];
    const output = await new Promise((resolve, reject) => {
      const child = spawn(command[0], command.slice(1), { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Language probe timed out')); }, 160000);
      child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(JSON.parse(out)) : reject(new Error('Probe failed: ' + err)); });
      child.stdin.end(JSON.stringify({ apiURL: origin, rootFingerprint, notification }));
    });
    assert.deepEqual(failures, []); assert.equal(output.deviceCount, 2);
    assert.equal(output.first.deduplicated, false); assert.equal(output.second.deduplicated, true);
    assert.deepEqual(output.errors, ['INVALID_SOUND', 'UNKNOWN_DEVICE', 'HTTP_409']);
    assert.equal(output.envelope.sound, 'chime');
    assert.equal(output.sent.envelope.sound, 'silent');
    assert.equal(output.defaultEnvelope.sound, 'default');
    assert.ok(!Object.hasOwn(output.legacyEnvelope, 'sound'));
    assert.deepEqual(output.envelope.notify_device_ids, []);
    assert.equal(output.envelope.scheduled_at, notification.scheduledAt);
    assert.equal(output.envelope.expires_at, notification.expiresAt);
    const full = await open(output.envelope), preview = await open(output.envelope, 'preview');
    assert.ok(!Object.hasOwn(full, 'sound')); assert.ok(!Object.hasOwn(preview, 'sound'));
    for (const envelope of [output.sent.envelope, output.defaultEnvelope, output.legacyEnvelope]) {
      assert.ok(!Object.hasOwn(await open(envelope), 'sound'));
      assert.ok(!Object.hasOwn(await open(envelope, 'preview'), 'sound'));
    }
    assert.equal(full.title, notification.title); assert.deepEqual(full.links, notification.links);
    assert.equal(full.attachments.length, 3); assert.equal(preview.image.id, full.image_id);
    assert.ok(full.attachments.some(a => a.id === full.icon_id));
    for (const descriptor of full.attachments) {
      const key = await webcrypto.subtle.importKey('raw', decode(descriptor.key), 'AES-GCM', false, ['decrypt']);
      const clear = Buffer.from(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(descriptor.nonce),
        additionalData: bytes(JSON.stringify([2, 'attachment', f.config.user_id, f.config.source_id, descriptor.id])) }, key, uploads.get(descriptor.id).data));
      assert.equal(clear.length, descriptor.size);
      if (descriptor.name === 'private.txt') assert.equal(clear.toString(), 'Sensitive fixture file');
    }
    assert.ok(!('notify_device_ids' in output.sent.envelope));
    const logs = JSON.stringify(output.logs);
    for (const secret of [f.config.source_key, notification.title, 'private.txt', 'test-device-code', output.envelope.ciphertext]) assert.ok(!logs.includes(secret));
    for (const log of output.logs) assert.deepEqual(Object.keys(log).sort(), ['elapsedMs', 'method', 'route', 'status']);
    // A well-formed encrypted grant must still fail an independently pinned wrong root.
    const wrongRoot = '0'.repeat(64);
    const begin = await execute({ operation: 'beginAuthorization', rootFingerprint: wrongRoot, apiURL: origin, name: 'Wrong-root test' });
    assert.equal(begin.ok, true);
    const denied = await execute({ operation: 'finishAuthorization', rootFingerprint: wrongRoot, pending: begin.data });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'E2EE_REQUEST_FAILED');
    failure = true;
    const error = await execute({ operation: 'recipients', rootFingerprint, config: { ...f.config, api_url: origin } });
    assert.equal(error.error.code, 'HTTP_503');
    assert.ok(!JSON.stringify(error).includes('secret-server-content-do-not-log'));
  } finally {
    f.directory.source_public_key = originalSourcePublic;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
