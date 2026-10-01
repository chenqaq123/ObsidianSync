import type { FeishuClient } from "./client";
import { pathSegment } from "./client";

export interface WikiSpace {
  space_id: string;
  name: string;
  description?: string;
  space_type?: string;
  visibility?: string;
}

export interface WikiNode {
  node_token: string;
  obj_token: string;
  obj_type: string;
  space_id?: string;
  parent_node_token?: string;
  node_type?: string;
  origin_node_token?: string;
  title?: string;
  has_child?: boolean;
}

export interface WikiTreeEntry {
  nodeToken: string;
  objToken: string;
  objType: string;
  parentNodeToken?: string;
  title: string;
  relDir: string;
  depth: number;
}

interface PageResult<T> {
  items?: T[];
  has_more?: boolean;
  page_token?: string;
}

const PAGE_SIZE = 50;
const MAX_DEPTH = 20;

function nextPage<T>(page: PageResult<T>, seen: Set<string>): string | undefined {
  if (!Array.isArray(page.items)) throw new Error("知识库列表响应缺少 items，已停止同步，避免误判远端删除");
  if (!page.has_more) return undefined;
  if (!page.page_token || seen.has(page.page_token)) throw new Error("知识库分页游标缺失或重复，已停止同步");
  seen.add(page.page_token);
  return page.page_token;
}

export async function listSpaces(client: FeishuClient): Promise<WikiSpace[]> {
  const spaces: WikiSpace[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  do {
    const page = await client.json<PageResult<WikiSpace>>("GET", "/open-apis/wiki/v2/spaces", {
      query: { page_size: PAGE_SIZE, page_token: pageToken },
    });
    spaces.push(...(page.items ?? []));
    pageToken = nextPage(page, seen);
  } while (pageToken);
  return spaces;
}

export async function listNodes(client: FeishuClient, spaceId: string, parentNodeToken?: string): Promise<WikiNode[]> {
  const nodes: WikiNode[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  do {
    const page = await client.json<PageResult<WikiNode>>("GET", `/open-apis/wiki/v2/spaces/${pathSegment(spaceId)}/nodes`, {
      query: { page_size: PAGE_SIZE, parent_node_token: parentNodeToken, page_token: pageToken },
    });
    nodes.push(...(page.items ?? []));
    pageToken = nextPage(page, seen);
  } while (pageToken);
  return nodes;
}

export async function getNodeByToken(client: FeishuClient, token: string, objType?: string): Promise<WikiNode | undefined> {
  const data = await client.json<{ node?: WikiNode }>("GET", "/open-apis/wiki/v2/spaces/node_by_token", {
    query: { token, obj_type: objType },
  });
  return data?.node;
}

export async function walkWikiTree(
  client: FeishuClient,
  spaceId: string,
  rootNodeToken: string | undefined,
  options: { rootContainerNode?: string; onProgress?: (visited: number, relDir: string) => void } = {},
): Promise<WikiTreeEntry[]> {
  const entries: WikiTreeEntry[] = [];
  // rootNodeToken 为空表示以知识空间顶层为根
  const queue: { nodeToken: string | undefined; relDir: string; depth: number }[] = [{ nodeToken: rootNodeToken, relDir: "", depth: 0 }];
  const visited = new Set<string>(rootNodeToken ? [rootNodeToken] : []);
  const onProgress = options.onProgress;

  while (queue.length > 0) {
    const current = queue.shift() as { nodeToken: string | undefined; relDir: string; depth: number };
    if (current.depth > MAX_DEPTH) throw new Error(`知识库目录超过 ${MAX_DEPTH} 层，请选择更小的同步根节点；未执行同步`);
    const nodes = await listNodes(client, spaceId, current.nodeToken);
    for (const node of nodes) {
      const title = (node.title ?? "").trim();
      // 快捷方式指向别处已有的节点，跟着递归会把同一篇笔记重复算进不同路径
      if (node.node_type === "shortcut") continue;
      if (visited.has(node.node_token)) continue;
      visited.add(node.node_token);
      if (node.obj_type === "file") {
        if (!/\.md$/i.test(title)) continue;
        entries.push({
          nodeToken: node.node_token,
          objToken: node.obj_token,
          objType: node.obj_type,
          parentNodeToken: node.parent_node_token,
          title,
          relDir: current.relDir,
          depth: current.depth + 1,
        });
        continue;
      }
      // 存放 vault 根目录笔记的顶层页面，其子节点的路径前缀仍视为「根」
      const childDir =
        node.node_token === options.rootContainerNode ? "" : current.relDir ? `${current.relDir}/${title}` : title;
      entries.push({
        nodeToken: node.node_token,
        objToken: node.obj_token,
        objType: node.obj_type,
        parentNodeToken: node.parent_node_token,
        title,
        relDir: current.relDir,
        depth: current.depth + 1,
      });
      if (node.has_child === false) continue;
      queue.push({ nodeToken: node.node_token, relDir: childDir, depth: current.depth + 1 });
    }
    onProgress?.(entries.length, current.relDir);
  }
  return entries;
}

export async function createContainerNode(
  client: FeishuClient,
  spaceId: string,
  parentNodeToken: string | undefined,
  title: string,
): Promise<WikiNode> {
  const body: Record<string, unknown> = {
    obj_type: "docx",
    node_type: "origin",
    title,
  };
  // 不传 parent_node_token 即在知识空间顶层创建一级节点
  if (parentNodeToken) body.parent_node_token = parentNodeToken;
  const data = await client.json<{ node?: WikiNode }>("POST", `/open-apis/wiki/v2/spaces/${pathSegment(spaceId)}/nodes`, { body });
  if (!data?.node?.node_token) {
    throw new Error(`创建知识库节点失败：${title}`);
  }
  return data.node;
}

export async function moveDocToWiki(
  client: FeishuClient,
  spaceId: string,
  parentNodeToken: string | undefined,
  objToken: string,
  objType: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    obj_type: objType,
    obj_token: objToken,
    apply: true,
  };
  // 不传 parent_wiki_token 即移动到知识空间一级
  if (parentNodeToken) body.parent_wiki_token = parentNodeToken;
  await client.json<unknown>("POST", `/open-apis/wiki/v2/spaces/${pathSegment(spaceId)}/nodes/move_docs_to_wiki`, { body });
}
