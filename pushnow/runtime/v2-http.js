import { validateConfig } from './client.js';

export function validateAPIURL(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Use an HTTPS API origin (HTTP is allowed only on localhost)');
  }
  return url.origin;
}

export class APIError extends Error {
  constructor(status) { super(`PushNow API request failed (HTTP ${status})`); this.status = status; }
}

export async function request(apiURL, path, { token, method = 'GET', body, binary = false,
  headers = {}, signal, fetcher = fetch } = {}) {
  const response = await fetcher(new URL(path, validateAPIURL(apiURL)), {
    method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': binary ? 'application/octet-stream' : 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
  });
  if (!response.ok) throw new APIError(response.status);
  if (response.status === 204) return null;
  return response.json();
}

export function authenticated(config, path, options = {}) {
  validateConfig(config);
  return request(config.api_url, path, { ...options, token: config.source_key });
}

