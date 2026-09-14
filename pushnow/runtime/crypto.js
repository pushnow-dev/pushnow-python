import { webcrypto } from 'node:crypto';
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';

export const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm(),
});
const utf8 = new TextEncoder();
export const bytes = (value) => utf8.encode(value);
export const base64 = (value) => Buffer.from(value).toString('base64');
export function decode(value, size) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid Base64 encoding');
  }
  const data = Buffer.from(value, 'base64');
  if (size !== undefined && data.length !== size) throw new Error('Invalid key or signature size');
  return data;
}

export function certificateText(kind, userId, id, publicKey) {
  return `pushnow-${kind}-v1\n${userId}\n${id}\n${publicKey}`;
}

export async function verifyCertificate(root, kind, userId, id, publicKey, signature) {
  try {
    const key = await webcrypto.subtle.importKey('raw', decode(root, 65),
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    decode(publicKey, 65);
    return await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key,
      decode(signature, 64), bytes(certificateText(kind, userId, id, publicKey)));
  } catch { return false; }
}

export function messageAAD({ user_id, source_id, device_id, message_id, expires_at }) {
  return bytes(`pushnow-message-v1\n${user_id}\n${source_id}\n${device_id}\n${message_id}\n${expires_at}`);
}

export async function encryptForDevice(privateKey, publicKey, metadata, plaintext) {
  const sender = await suite.createSenderContext({
    recipientPublicKey: await suite.kem.deserializePublicKey(decode(publicKey, 65)),
    senderKey: await suite.kem.deserializePrivateKey(decode(privateKey, 32)),
    info: bytes('pushnow-message-v1'),
  });
  const ciphertext = await sender.seal(bytes(JSON.stringify(plaintext)), messageAAD(metadata));
  if (ciphertext.byteLength > 2400) throw new Error('Message exceeds encrypted notification size limit');
  return { device_id: metadata.device_id, enc: base64(sender.enc), ciphertext: base64(ciphertext) };
}

export async function decryptForTest(privateKey, senderPublicKey, envelope, metadata) {
  const recipient = await suite.createRecipientContext({
    recipientKey: await suite.kem.deserializePrivateKey(decode(privateKey, 32)),
    senderPublicKey: await suite.kem.deserializePublicKey(decode(senderPublicKey, 65)),
    enc: decode(envelope.enc, 65), info: bytes('pushnow-message-v1'),
  });
  return JSON.parse(Buffer.from(await recipient.open(decode(envelope.ciphertext), messageAAD(metadata))).toString('utf8'));
}

