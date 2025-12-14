/**
 * Mock implementation of uuid for Jest tests
 * Matches uuid v13.x API shape (named exports only)
 */

// UUID v4 format regex for validation
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Counter for deterministic UUID generation
let uuidCounter = 0;

/**
 * Reset the UUID counter (useful for test isolation)
 */
export function resetUuidCounter(): void {
  uuidCounter = 0;
}

/**
 * Generate a deterministic mock UUID v4
 * Returns predictable UUIDs based on an incrementing counter
 */
export function v4(): string {
  const count = uuidCounter++;
  // Generate a deterministic UUID using the counter
  // Format: 00000000-0000-4000-8000-{counter padded to 12 hex digits}
  const counterHex = count.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${counterHex}`;
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
 * Converts a 16-byte Uint8Array to UUID string format
 */
export function stringify(arr: Uint8Array | ArrayLike<number>): string {
  // Input validation
  if (arr === null || arr === undefined) {
    throw new TypeError('Invalid input: expected Uint8Array or ArrayLike<number>');
  }

  if (!(arr instanceof Uint8Array) && !Array.isArray(arr) && typeof arr.length !== 'number') {
    throw new TypeError('Invalid input: expected Uint8Array or ArrayLike<number>');
  }

  if (arr.length !== 16) {
    throw new RangeError(`Invalid input: expected 16 bytes, got ${arr.length}`);
  }

  // Validate each byte is a valid number 0-255
  for (let i = 0; i < 16; i++) {
    const byte = arr[i];
    if (typeof byte !== 'number' || byte < 0 || byte > 255 || !Number.isInteger(byte)) {
      throw new TypeError(`Invalid byte at index ${i}: expected integer 0-255, got ${byte}`);
    }
  }

  const hex = Array.from(arr)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
