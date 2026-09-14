import { setTimeout as delay } from 'node:timers/promises';
import { validateConfig } from './client.js';
import { request, authenticated, validateAPIURL, APIError } from './v2-http.js';
import { fingerprint, generateAgreementKey, openSenderGrant, verifyArchive } from './v2-crypto.js';

export async function beginLogin(apiURL, name, options = {}) {
  const api_url = validateAPIURL(apiURL), key = generateAgreementKey();
  const authorization = await request(api_url, '/v2/authorizations', {
    ...options, method: 'POST', body: { name, public_key: key.publicKey },
  });
  if (!authorization.id || !authorization.device_code || !authorization.user_code ||
      !Number.isFinite(Date.parse(authorization.expires_at))) throw new Error('Invalid authorization response');
  return { api_url, key, authorization, fingerprint: fingerprint(key.publicKey) };
}

export async function beginAccountLogin(apiURL, accessToken, name, options = {}) {
  const api_url = validateAPIURL(apiURL), key = generateAgreementKey();
  if (typeof accessToken !== 'string' || !accessToken) throw new Error('Account access token is required');
  const authorization = await request(api_url, '/v2/account-authorizations', {
    ...options, token: accessToken, method: 'POST', body: { name, public_key: key.publicKey },
  });
  if (!authorization.id || !authorization.device_code || !authorization.user_code || !authorization.user_id ||
      !authorization.identity_public_key || !Number.isFinite(Date.parse(authorization.expires_at))) {
    throw new Error('Invalid account authorization response');
  }
  return { api_url, key, authorization, fingerprint: fingerprint(key.publicKey),
    accountUserID: authorization.user_id, expectedRootFingerprint: fingerprint(authorization.identity_public_key) };
}

export async function finishLogin(pending, { signal, fetcher = fetch, wait = delay, confirmIdentity, expectedIdentityFingerprint } = {}) {
  const { authorization, api_url, key } = pending;
  while (Date.now() < Date.parse(authorization.expires_at)) {
    signal?.throwIfAborted();
    let response;
    try {
      response = await request(api_url, `/v2/authorizations/${encodeURIComponent(authorization.id)}/token`,
        { method: 'POST', body: { device_code: authorization.device_code }, signal, fetcher });
    } catch (error) {
      if (!(error instanceof APIError) || error.status !== 429) throw error;
    }
    if (response?.status === 'approved') {
      if (!response.grant) throw new Error('Authorization grant missing');
      const grant = await openSenderGrant(authorization, key, response.grant);
      if (validateAPIURL(grant.api_url) !== api_url) throw new Error('Authorization API origin changed');
      const config = validateConfig({ ...grant, sender_private_key: key.privateKey });
      await verifyArchive(config, config.archive);
      const accountFingerprint = fingerprint(config.identity_public_key);
      const confirmed = expectedIdentityFingerprint ? expectedIdentityFingerprint.toLowerCase() === accountFingerprint :
        confirmIdentity && await confirmIdentity({ fingerprint: accountFingerprint, userID: config.user_id });
      if (!confirmed) {
        throw new Error('Account identity not confirmed; remove this authorization in the app');
      }
      return config;
    }
    if (response && response.status !== 'pending') throw new Error('Unexpected authorization state');
    await wait(Math.max(3, Number(authorization.interval) || 3) * 1000, undefined, { signal });
  }
  throw new Error('Authorization expired; start login again');
}

export async function finishAccountLogin(pending, options = {}) {
  const config = await finishLogin(pending, { ...options, expectedIdentityFingerprint: pending.expectedRootFingerprint });
  if (config.user_id !== pending.accountUserID) throw new Error('Authorization account changed');
  return config;
}

export async function revokeSender(config, options = {}) {
  try { return await authenticated(config, '/v2/logout', { ...options, method: 'POST', body: {} }); }
  catch (error) { if (error instanceof APIError && error.status === 401) return null; throw error; }
}
