import type { FeishuClient } from "./client";
import { FeishuError, pathSegment } from "./client";
import { moveDocToWiki } from "./wiki";

export interface RemoteMeta {
  token: string;
  title?: string;
  url?: string;
  modifiedTime?: string;
}

export interface UploadResult {
  fileToken: string;
  version?: string;
}

const META_CHUNK = 50;

function pickString(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

export async function batchQueryMetas(client: FeishuClient, tokens: string[], docType = "file"): Promise<Map<string, RemoteMeta>> {
  const result = new Map<string, RemoteMeta>();
  for (let index = 0; index < tokens.length; index += META_CHUNK) {
    const chunk = tokens.slice(index, index + META_CHUNK);
    const data = await client.json<{ metas?: Record<string, unknown>[] }>("POST", "/open-apis/drive/v1/metas/batch_query", {
      body: {
        request_docs: chunk.map((token) => ({ doc_token: token, doc_type: docType })),
        with_url: true,
      },
    });
    for (const meta of data?.metas ?? []) {
      const token = pickString(meta, ["doc_token", "token"]);
      if (!token) continue;
      result.set(token, {
        token,
        title: pickString(meta, ["title", "name"]),
        url: pickString(meta, ["url"]),
        modifiedTime: pickString(meta, ["latest_modify_time", "modified_time", "latest_modify_time_ms"]),
      });
    }
  }
  return result;
}

export async function uploadMarkdown(
  client: FeishuClient,
  options: {
    fileName: string;
    data: ArrayBuffer;
    parentType: "wiki" | "explorer";
    parentNode: string;
    fileToken?: string;
  },
): Promise<UploadResult> {
  const fields: Record<string, string> = {
    file_name: options.fileName,
    parent_type: options.parentType,
    parent_node: options.parentNode,
    size: String(options.data.byteLength),
  };
  if (options.fileToken) fields.file_token = options.fileToken;

  const data = await client.json<{ file_token?: string; version?: string }>("POST", "/open-apis/drive/v1/files/upload_all", {
    multipart: { fields, file: { name: options.fileName, data: options.data } },
  });
  const fileToken = pickString(data as Record<string, unknown>, ["file_token"]) ?? options.fileToken;
  if (!fileToken) throw new Error(`上传 ${options.fileName} 后未返回 file_token`);
  return { fileToken, version: pickString(data as Record<string, unknown>, ["version"]) };
}

export async function downloadFile(client: FeishuClient, fileToken: string, version?: string): Promise<ArrayBuffer> {
  const bytes = await client.binary(`/open-apis/drive/v1/medias/${pathSegment(fileToken)}/preview_download`, version ? { version } : undefined);
  if (bytes.byteLength === 0) {
    // 飞书不接受 0 字节 Markdown，正常远端文件不可能是空的；空响应多半是网关/网络问题，绝不能拿去覆盖本地
    throw new Error(`远端 ${fileToken} 返回了空内容，已放弃本次覆盖`);
  }
  return bytes;
}

/**
 * 删除云空间文件/文档。走 drive 接口而不是 wiki 的删节点接口：drive 只需 drive:drive 权限，
 * 云空间文件删掉后对应的 wiki 节点会一并消失；删除进飞书回收站，可以恢复。
 */
export async function deleteDriveFile(client: FeishuClient, token: string, type: "file" | "docx"): Promise<void> {
  await client.json<unknown>("DELETE", `/open-apis/drive/v1/files/${pathSegment(token)}`, { query: { type } });
}

/**
 * 上传到知识库节点。官方文档只写了 parent_type=explorer，但官方 CLI 用 parent_type=wiki 直传，
 * 这里以 wiki 为主、以"上传到云空间再 move_docs_to_wiki"为降级路径。
 */
export async function uploadMarkdownToWiki(
  client: FeishuClient,
  options: { spaceId: string; parentNode: string | undefined; fileName: string; data: ArrayBuffer; fileToken?: string },
  onFallback?: (reason: string) => void,
): Promise<UploadResult> {
  const driveThenMove = async (): Promise<UploadResult> => {
    const uploaded = await uploadMarkdown(client, {
      fileName: options.fileName,
      data: options.data,
      parentType: "explorer",
      parentNode: "",
    });
    await moveDocToWiki(client, options.spaceId, options.parentNode, uploaded.fileToken, "file");
    return uploaded;
  };

  // 空间一级没有可用的 parent_node，wiki 直传必须带节点，只能走"云空间中转"
  if (!options.fileToken && !options.parentNode) {
    return driveThenMove();
  }

  try {
    return await uploadMarkdown(client, {
      fileName: options.fileName,
      data: options.data,
      parentType: "wiki",
      parentNode: options.parentNode ?? "",
      fileToken: options.fileToken,
    });
  } catch (error) {
    if (error instanceof FeishuError && error.authRelated) throw error;
    // 覆盖已有文件时不能换位置，兜底只会产生重复文件
    if (options.fileToken) throw error;
    onFallback?.(error instanceof Error ? error.message : String(error));
    return driveThenMove();
  }
}
