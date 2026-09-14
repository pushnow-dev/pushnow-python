import { createECDH, createHash, randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { suite, bytes, base64, decode, verifyCertificate } from './crypto.js';

export function generateAgreementKey() {
  const pair = createECDH('prime256v1'); pair.generateKeys();
  const raw = Buffer.from(pair.getPrivateKey().toString('hex').padStart(64, '0'), 'hex');
  return { privateKey: base64(raw), publicKey: base64(pair.getPublicKey()) };
}
export const fingerprint = key => createHash('sha256').update(decode(key, 65)).digest('hex');
export const v2AAD = (purpose, config, messageID, archiveID) =>
  bytes(JSON.stringify([2, purpose, config.user_id, config.source_id, messageID, archiveID]));

export async function verifyArchive(config, archive) {
  if (!archive || typeof archive.id !== 'string' ||
      !await verifyCertificate(config.identity_public_key, 'archive', config.user_id, archive.id, archive.public_key, archive.certificate)) {
    throw new Error('Account archive certificate is invalid');
  }
  if (config.archive && (config.archive.id !== archive.id || config.archive.public_key !== archive.public_key)) {
    throw new Error('Pinned account archive changed');
  }
  return archive;
}

export async function sealV2(config, archive, purpose, messageID, plaintext) {
  const sender = await suite.createSenderContext({
    recipientPublicKey: await suite.kem.deserializePublicKey(decode(archive.public_key, 65)),
    senderKey: await suite.kem.deserializePrivateKey(decode(config.sender_private_key, 32)), info: bytes('pushnow-v2'),
  });
  return { enc: base64(sender.enc), ciphertext: base64(await sender.seal(bytes(JSON.stringify(plaintext)),
    v2AAD(purpose, config, messageID, archive.id))) };
}

export async function openSenderGrant(authorization, key, grant) {
  const recipient = await suite.createRecipientContext({
    recipientKey: await suite.kem.deserializePrivateKey(decode(key.privateKey, 32)),
    enc: decode(grant.enc, 65), info: bytes('pushnow-sender-grant-v2'),
  });
  const clear = await recipient.open(decode(grant.ciphertext),
    bytes(JSON.stringify([2, 'sender-grant', authorization.id, key.publicKey])));
  return JSON.parse(Buffer.from(clear).toString('utf8'));
}

export async function encryptAttachment(config, data, { name, mime = 'application/octet-stream', id = randomUUID() }) {
  const clear = Buffer.from(data);
  if (clear.length > 20 * 1024 * 1024 - 16) throw new Error('Attachment exceeds 20 MiB encrypted size limit');
  const key = randomBytes(32), nonce = randomBytes(12);
  const aes = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ciphertext = Buffer.from(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
    additionalData: bytes(JSON.stringify([2, 'attachment', config.user_id, config.source_id, id])) }, aes, clear));
  return { ciphertext, descriptor: { id, name, mime, size: clear.length, read_token: randomBytes(32).toString('base64url'), key: base64(key), nonce: base64(nonce),
    sha256: createHash('sha256').update(clear).digest('hex') } };
}

