import type { App } from "obsidian";
import type { Logger } from "../log";
import { LEGACY_CONFLICT_DIR } from "./types";

/** 旧版会把远端冲突版本存到仓库；新版只标记冲突，启动时清掉这些插件生成的副本。 */
export async function removeLegacyConflictCopies(app: App, logger: Logger): Promise<void> {
  const adapter = app.vault.adapter;
  try {
    if (await adapter.exists(LEGACY_CONFLICT_DIR)) {
      await adapter.rmdir(LEGACY_CONFLICT_DIR, true);
      logger.info("已清理旧版冲突副本目录");
    }
  } catch (error) {
    logger.warn(`旧版冲突副本清理失败：${String(error)}`);
  }
}
