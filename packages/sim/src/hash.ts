// 32-bit FNV-1a over canonical sim state bytes. Byte order of multi-byte
// fields is the platform's typed-array order; all supported targets
// (V8/JSC/SpiderMonkey on x86-64 and ARM64) are little-endian, and the golden
// replay tests would catch a big-endian outlier immediately.

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function fnv1aInit(): number {
  return FNV_OFFSET_BASIS;
}

/** Folds bytes[start..end) into the running hash h. */
export function fnv1aBytes(h: number, bytes: Uint8Array, start: number, end: number): number {
  let acc = h;
  for (let i = start; i < end; i++) {
    acc = Math.imul(acc ^ bytes[i], FNV_PRIME) >>> 0;
  }
  return acc;
}

/** Folds one unsigned 32-bit value (little-endian byte order) into h. */
export function fnv1aU32(h: number, v: number): number {
  let acc = h;
  acc = Math.imul(acc ^ (v & 0xff), FNV_PRIME) >>> 0;
  acc = Math.imul(acc ^ ((v >>> 8) & 0xff), FNV_PRIME) >>> 0;
  acc = Math.imul(acc ^ ((v >>> 16) & 0xff), FNV_PRIME) >>> 0;
  acc = Math.imul(acc ^ ((v >>> 24) & 0xff), FNV_PRIME) >>> 0;
  return acc;
}
