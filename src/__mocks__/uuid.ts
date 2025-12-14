/**
 * Mock implementation of uuid for Jest tests
 */

// UUID v4 format regex for validation
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Generate a mock UUID v4
 */
export function v4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Validate a UUID
 */
export function validate(uuid: string): boolean {
  return uuidRegex.test(uuid);
}

/**
 * Parse a UUID (mock implementation)
 */
export function parse(uuid: string): Uint8Array {
  if (!validate(uuid)) {
    throw new TypeError('Invalid UUID');
  }
  const hex = uuid.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Stringify a UUID (mock implementation)
 */
export function stringify(arr: Uint8Array): string {
  const hex = Array.from(arr)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default {
  v4,
  validate,
  parse,
  stringify,
};
