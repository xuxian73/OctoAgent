import { inflateRawSync } from "node:zlib";

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Strict classic ZIP subset, bounded in memory; never writes or executes entries. */
export function validateZip(input: Uint8Array): void {
  const budget = { bytes: 0, entries: 0, deadline: Date.now() + 2000 };
  const fail = (reason: string): never => {
    throw new Error("ZIP_" + reason);
  };
  function inspect(b: Buffer, depth: number) {
    if (depth > 3) fail("NESTING_LIMIT");
    if (b.length > 10 * 1024 * 1024) fail("SIZE_LIMIT");
    let end = b.length - 22;
    while (
      end >= Math.max(0, b.length - 65557) &&
      b.readUInt32LE(end) !== 0x06054b50
    )
      end--;
    if (
      end < 0 ||
      end + 22 > b.length ||
      end + 22 + b.readUInt16LE(end + 20) !== b.length
    )
      fail("CORRUPT");
    if (b.readUInt16LE(end + 4) || b.readUInt16LE(end + 6)) fail("MULTIDISK");
    const count = b.readUInt16LE(end + 10);
    if (!count || count !== b.readUInt16LE(end + 8) || count === 65535)
      fail("EMPTY_OR_UNSUPPORTED");
    let central = b.readUInt32LE(end + 16);
    const start = central;
    if (central + b.readUInt32LE(end + 12) !== end) fail("CORRUPT");
    let localEnd = 0;
    const names = new Set<string>();
    for (let n = 0; n < count; n++) {
      if (++budget.entries > 1000 || Date.now() > budget.deadline)
        fail("RESOURCE_LIMIT");
      if (central + 46 > end || b.readUInt32LE(central) !== 0x02014b50)
        fail("CORRUPT");
      const flags = b.readUInt16LE(central + 8),
        method = b.readUInt16LE(central + 10);
      if (flags & ~(method === 8 ? 0x80e : 0x808) || ![0, 8].includes(method))
        fail("ENCRYPTED_OR_UNSUPPORTED");
      const crc = b.readUInt32LE(central + 16),
        compressed = b.readUInt32LE(central + 20),
        size = b.readUInt32LE(central + 24);
      budget.bytes += size;
      if (
        budget.bytes > 20 * 1024 * 1024 ||
        size > 10 * 1024 * 1024 ||
        size > Math.max(1024, compressed * 100)
      )
        fail("EXPANSION_LIMIT");
      const length = b.readUInt16LE(central + 28),
        extra = b.readUInt16LE(central + 30),
        comment = b.readUInt16LE(central + 32);
      const offset = b.readUInt32LE(central + 42);
      if (
        central + 46 + length + extra + comment > end ||
        b.readUInt16LE(central + 34)
      )
        fail("CORRUPT");
      const rawName = b.subarray(central + 46, central + 46 + length);
      const name = new TextDecoder("utf-8", { fatal: true }).decode(rawName);
      if (
        !name ||
        /[\\:\x00-\x1f]/.test(name) ||
        name.startsWith("/") ||
        name
          .split("/")
          .some(
            p =>
              p === ".." ||
              p === "." ||
              /[. ]$/.test(p) ||
              /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)
          ) ||
        names.has(name)
      )
        fail("DANGEROUS_PATH");
      names.add(name);
      const mode = b.readUInt32LE(central + 38) >>> 16;
      if (mode & 0xf000 && ![0x8000, 0x4000].includes(mode & 0xf000))
        fail("SPECIAL_ENTRY");
      if (
        offset !== localEnd ||
        offset + 30 > start ||
        b.readUInt32LE(offset) !== 0x04034b50 ||
        b.readUInt16LE(offset + 6) !== flags ||
        b.readUInt16LE(offset + 8) !== method
      )
        fail("CORRUPT");
      const localLength = b.readUInt16LE(offset + 26),
        localExtra = b.readUInt16LE(offset + 28);
      const dataStart = offset + 30 + localLength + localExtra;
      if (
        localLength !== length ||
        !b.subarray(offset + 30, offset + 30 + length).equals(rawName) ||
        dataStart + compressed > start
      )
        fail("CORRUPT");
      if (
        !(flags & 8) &&
        (b.readUInt32LE(offset + 14) !== crc ||
          b.readUInt32LE(offset + 18) !== compressed ||
          b.readUInt32LE(offset + 22) !== size)
      )
        fail("CORRUPT");
      const packed = b.subarray(dataStart, dataStart + compressed);
      let bytes = packed;
      if (method === 8) {
        const inflated = (inflateRawSync(packed, {
          maxOutputLength: Math.max(1, size),
          info: true
        }) as unknown) as { buffer: Buffer; engine: { bytesWritten: number } };
        if (inflated.engine.bytesWritten !== compressed) fail("CORRUPT");
        bytes = inflated.buffer;
      }
      if (bytes.length !== size || crc32(bytes) !== crc) fail("CORRUPT");
      localEnd = dataStart + compressed;
      if (flags & 8) {
        if (localEnd + 4 <= start && b.readUInt32LE(localEnd) === 0x08074b50)
          localEnd += 4;
        if (
          localEnd + 12 > start ||
          b.readUInt32LE(localEnd) !== crc ||
          b.readUInt32LE(localEnd + 4) !== compressed ||
          b.readUInt32LE(localEnd + 8) !== size
        )
          fail("CORRUPT");
        localEnd += 12;
      }
      if (
        name.toLowerCase().endsWith(".zip") ||
        bytes.subarray(0, 2).toString() === "PK"
      )
        inspect(bytes, depth + 1);
      central += 46 + length + extra + comment;
    }
    if (localEnd !== start || central !== end || Date.now() > budget.deadline)
      fail("CORRUPT_OR_TIMEOUT");
  }
  try {
    inspect(Buffer.from(input), 0);
    if (!budget.bytes) fail("EMPTY");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("ZIP_")) throw error;
    throw new Error("ZIP_CORRUPT");
  }
}
