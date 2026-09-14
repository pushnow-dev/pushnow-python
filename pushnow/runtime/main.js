import { execute } from './bridge.js';
let text = '';
try {
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 600 * 1024 * 1024) throw new Error('large input');
  }
  process.stdout.write(JSON.stringify(await execute(JSON.parse(text))));
} catch {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: 'BRIDGE_INPUT_FAILED' }, logs: [] }));
}

