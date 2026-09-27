import type { FeishuClient } from "./client";
import { FeishuError, pathSegment } from "./client";

/**
 * 文档里的图片素材协议（照抄官方 CLI：shortcuts/doc/local_doc_resources.go、
 * doc_media_upload.go、doc_media_download.go、doc_media_insert.go）：
 *   1. content 里把本地图片写成占位块 <img path="@lcli_img_<32hex>" caption="…"/>
 *   2. docs_ai 建/更新文档后，从返回的 document.new_blocks 里按 block_token(=标记) 找到 block_id
 *   3. multipart 上传素材 upload_all（parent_type=docx_image、parent_node=block_id、extra.drive_route_token=文档 id）
 *   4. PATCH docx/v1/documents/{id}/blocks/batch_update 用 replace_image.token 绑定
 *   5. 绑定失败时用 docs_ai 的 block_delete 清掉占位块，别把标记留在文档里
 */

export const IMAGE_BLOCK_TYPE = 27;
export const MAX_SINGLE_PART_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface DocNewBlock {
  blockId: string;
  blockToken?: string;
  blockType?: string | number;
}

export interface DocImageBlock {
  blockId: string;
  fileToken?: string;
  marker?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readString(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  if (typeof value === "string" && value) return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

/** docs_ai 建/更新文档返回里的占位块列表（block_token 就是本地资源标记）。 */
export function readNewBlocks(data: unknown): DocNewBlock[] {
  const document = asRecord(asRecord(data)?.document);
  const blocks = document?.new_blocks;
  if (!Array.isArray(blocks)) return [];
  const out: DocNewBlock[] = [];
  for (const raw of blocks) {
    const block = asRecord(raw);
    const blockId = readString(block, "block_id");
    if (!blockId) continue;
    out.push({ blockId, blockToken: readString(block, "block_token"), blockType: block?.block_type as string | number | undefined });
  }
  return out;
}

export function readRevisionId(data: unknown): number | undefined {
  const document = asRecord(asRecord(data)?.document);
  const value = document?.revision_id;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function isImageBlock(blockType: string | number | undefined): boolean {
  if (typeof blockType === "number") return blockType === IMAGE_BLOCK_TYPE;
  if (typeof blockType === "string") {
    const trimmed = blockType.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed) === IMAGE_BLOCK_TYPE;
    return trimmed.toLowerCase() === "image";
  }
  return false;
}

/** 占位块 → block_id：只认「标记命中且块类型是图片」的那一个（官方要求恰好一个）。 */
export function correlateImageBlocks(blocks: DocNewBlock[], markers: string[]): Map<string, string> {
  const wanted = new Set(markers);
  const byMarker = new Map<string, DocNewBlock[]>();
  for (const block of blocks) {
    if (!block.blockToken || !wanted.has(block.blockToken)) continue;
    const list = byMarker.get(block.blockToken) ?? [];
    list.push(block);
    byMarker.set(block.blockToken, list);
  }
  const result = new Map<string, string>();
  for (const marker of markers) {
    const matches = (byMarker.get(marker) ?? []).filter((block) => isImageBlock(block.blockType));
    if (matches.length === 1) result.set(marker, matches[0].blockId);
  }
  return result;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  const cryptoObj = (globalThis as unknown as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(buffer);
  } else {
    for (let index = 0; index < buffer.length; index += 1) buffer[index] = Math.floor(Math.random() * 256);
  }
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 标记格式必须与官方一致（@lcli_img_ + 32 位 hex），服务端按它把占位块关联回来。 */
export function newImageMarker(): string {
  return `@lcli_img_${randomHex(16)}`;
}

export function newClientToken(): string {
  const hex = randomHex(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function uploadDocImage(
  client: FeishuClient,
  options: { documentId: string; blockId: string; fileName: string; bytes: ArrayBuffer },
): Promise<string> {
  if (options.bytes.byteLength > MAX_SINGLE_PART_UPLOAD_BYTES) {
    throw new Error(`图片 ${options.fileName} 超过 20MB，单次上传接口不支持（官方 CLI 走分片上传，本插件暂未实现）`);
  }
  const data = await client.json<{ file_token?: string }>("POST", "/open-apis/drive/v1/medias/upload_all", {
    multipart: {
      fields: {
        file_name: options.fileName,
        parent_type: "docx_image",
        parent_node: options.blockId,
        size: String(options.bytes.byteLength),
        extra: JSON.stringify({ drive_route_token: options.documentId }),
      },
      file: { name: options.fileName, data: options.bytes },
    },
  });
  const fileToken = readString(data as Record<string, unknown>, "file_token");
  if (!fileToken) throw new Error(`上传图片 ${options.fileName} 后没有拿到 file_token`);
  return fileToken;
}

export async function bindDocImages(
  client: FeishuClient,
  documentId: string,
  requests: { blockId: string; fileToken: string }[],
): Promise<void> {
  if (requests.length === 0) return;
  await client.json<unknown>(
    "PATCH",
    `/open-apis/docx/v1/documents/${pathSegment(documentId)}/blocks/batch_update`,
    {
      query: { client_token: newClientToken() },
      body: { requests: requests.map((item) => ({ block_id: item.blockId, replace_image: { token: item.fileToken } })) },
    },
  );
}

/** 绑定后回读块确认真的绑上了（复用缓存的 token 时必须确认）。 */
export async function getDocBlockToken(client: FeishuClient, documentId: string, blockId: string): Promise<string | undefined> {
  const data = await client.json<{ block?: Record<string, unknown> }>(
    "GET",
    `/open-apis/docx/v1/documents/${pathSegment(documentId)}/blocks/${pathSegment(blockId)}`,
  );
  const block = asRecord(data?.block);
  if (!block) return undefined;
  const image = asRecord(block.image);
  return readString(image, "token") ?? readString(block, "token");
}

/** 占位块清不掉时至少别把标记留在文档里：用 docs_ai 的 block_delete 删除它们。 */
export async function deleteDocBlocks(
  client: FeishuClient,
  documentId: string,
  blockIds: string[],
  revisionId?: number,
): Promise<void> {
  if (blockIds.length === 0) return;
  await client.json<unknown>("PUT", `/open-apis/docs_ai/v1/documents/${pathSegment(documentId)}`, {
    body: {
      format: "xml",
      command: "block_delete",
      block_id: blockIds.join(","),
      revision_id: revisionId ?? -1,
    },
  });
}

/** 文档里的图片块（下行兜底：取回的 Markdown 里拿不到素材 token 时按顺序对应）。 */
export async function listDocImageBlocks(client: FeishuClient, documentId: string): Promise<DocImageBlock[]> {
  const blocks: DocImageBlock[] = [];
  let pageToken: string | undefined;
  do {
    const data = await client.json<{ items?: Record<string, unknown>[]; has_more?: boolean; page_token?: string }>(
      "GET",
      `/open-apis/docx/v1/documents/${pathSegment(documentId)}/blocks`,
      { query: { page_size: 500, document_revision_id: -1, page_token: pageToken } },
    );
    for (const raw of data?.items ?? []) {
      const block = asRecord(raw);
      if (!block || !isImageBlock(block.block_type as string | number | undefined)) continue;
      const image = asRecord(block.image);
      blocks.push({
        blockId: readString(block, "block_id") ?? "",
        fileToken: readString(image, "token"),
        marker: readString(block, "block_token"),
      });
    }
    pageToken = data?.has_more ? data.page_token : undefined;
  } while (pageToken);
  return blocks;
}

export async function downloadDocMedia(client: FeishuClient, fileToken: string): Promise<{ bytes: ArrayBuffer; contentType?: string }> {
  const response = await client.binaryResponse(`/open-apis/drive/v1/medias/${pathSegment(fileToken)}/download`);
  if (response.data.byteLength === 0) {
    throw new FeishuError(`素材 ${fileToken} 下载得到 0 字节，已放弃`, { endpoint: `/open-apis/drive/v1/medias/${fileToken}/download` });
  }
  return { bytes: response.data, contentType: response.contentType };
}
