import crypto from 'node:crypto';

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function assertSafeId(value, name) {
  if (!ID_PATTERN.test(value)) {
    throw new Error(`${name} must match ${ID_PATTERN}`);
  }
}

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function safeJsonParse(maybeJson, fallback = null) {
  try {
    return JSON.parse(maybeJson);
  } catch {
    return fallback;
  }
}

export function ensureSerializable(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Action output is not JSON-serializable.');
  }
  return JSON.parse(serialized);
}

export function randomId() {
  return crypto.randomUUID();
}
