interface NodeHash {
  update(data: Uint8Array): NodeHash;
  digest(encoding: "hex"): string;
}

interface NodeCrypto {
  createHash(algorithm: string): NodeHash;
}

function loadNodeCrypto(): NodeCrypto | null {
  const requireFn = (globalThis as unknown as { require?: (module: string) => unknown }).require;
  if (!requireFn) return null;
  try {
    return requireFn("crypto") as NodeCrypto;
  } catch {
    return null;
  }
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const nodeCrypto = loadNodeCrypto();
  if (nodeCrypto) {
    return nodeCrypto.createHash("sha256").update(new Uint8Array(data)).digest("hex");
  }
  const subtle = (globalThis as unknown as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", data);
    return toHex(new Uint8Array(digest));
  }
  throw new Error("当前环境没有可用的 SHA-256 实现");
}
