import type { App } from "obsidian";
import type { FeishuClient } from "../feishu/client";
import { createContainerNode, listNodes } from "../feishu/wiki";
import type { Logger } from "../log";
import type { PluginSettings, SyncState } from "./types";
import { basenameOf, dirnameOf } from "./types";

export interface FolderResolverDeps {
  app: App;
  client: FeishuClient;
  state: SyncState;
  settings: PluginSettings;
  spaceId: string;
  /** 留空表示以知识空间顶层为同步根 */
  rootNodeToken?: string;
  logger: Logger;
}

export interface FolderResolver {
  /** vault 根目录散装笔记的存放节点（未指定根节点时按需创建）。 */
  ensureRootContainer(): Promise<string>;
  /** relDir 对应的目录节点；needFileParent=false 只用于递归建目录：目录直接挂空间顶层。 */
  resolveFolderNode(relDir: string, needFileParent: boolean): Promise<string | undefined>;
}

/** 笔记必须挂在某个页面节点下；两种执行器共用这套目录解析与缓存。 */
export function createFolderResolver(deps: FolderResolverDeps): FolderResolver {
  const { state, settings } = deps;
  const folderNodes = new Map<string, string>();
  const pendingFolders = new Map<string, Promise<string | undefined>>();
  let rootContainerToken: string | undefined;
  let pendingRootContainer: Promise<string> | undefined;

  const ensureRootContainer = async (): Promise<string> => {
    if (deps.rootNodeToken) return deps.rootNodeToken;
    if (rootContainerToken) return rootContainerToken;
    if (pendingRootContainer) return pendingRootContainer;
    const resolving = (async (): Promise<string> => {
      const cached = state.folders[""];
      if (cached?.nodeToken) {
        rootContainerToken = cached.nodeToken;
        return rootContainerToken;
      }
      const title = settings.rootPageTitle.trim() || deps.app.vault.getName();
      const topLevel = await listNodes(deps.client, deps.spaceId);
      const found = topLevel.find((node) => node.title === title && node.obj_type !== "file");
      if (found?.node_token) {
        state.folders[""] = { nodeToken: found.node_token };
        rootContainerToken = found.node_token;
        deps.logger.info(`复用知识库顶层页面「${title}」存放 vault 根目录下的笔记`);
        return rootContainerToken;
      }
      const node = await createContainerNode(deps.client, deps.spaceId, undefined, title);
      state.folders[""] = { nodeToken: node.node_token };
      rootContainerToken = node.node_token;
      deps.logger.info(`在知识库顶层创建页面「${title}」存放 vault 根目录下的笔记`);
      return rootContainerToken;
    })();
    pendingRootContainer = resolving;
    try {
      return await resolving;
    } finally {
      pendingRootContainer = undefined;
    }
  };

  const resolveFolderNode = async (relDir: string, needFileParent: boolean): Promise<string | undefined> => {
    if (settings.folderMode === "flat" || relDir === "") {
      return needFileParent ? ensureRootContainer() : deps.rootNodeToken;
    }
    const cached = folderNodes.get(relDir);
    if (cached) return cached;
    const pending = pendingFolders.get(relDir);
    if (pending) return pending;
    const resolving = (async (): Promise<string> => {
      const existing = state.folders[relDir];
      if (existing?.nodeToken) {
        folderNodes.set(relDir, existing.nodeToken);
        return existing.nodeToken;
      }
      const parentDir = dirnameOf(relDir);
      const parentNode = await resolveFolderNode(parentDir, false);
      const node = await createContainerNode(deps.client, deps.spaceId, parentNode, basenameOf(relDir));
      state.folders[relDir] = { nodeToken: node.node_token, parentNodeToken: parentNode };
      folderNodes.set(relDir, node.node_token);
      deps.logger.info(`创建知识库目录节点 ${relDir} -> ${node.node_token}`);
      return node.node_token;
    })();
    pendingFolders.set(relDir, resolving);
    try {
      return await resolving;
    } finally {
      pendingFolders.delete(relDir);
    }
  };

  return { ensureRootContainer, resolveFolderNode };
}
