import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { __setRequestUrlHandler, TFile } from "obsidian";
import { FeishuClient, setRequestBudgetForTest } from "../src/feishu/client";
import { AuthManager } from "../src/feishu/auth";
import { listNodes, walkWikiTree } from "../src/feishu/wiki";
import { uploadMarkdownToWiki } from "../src/feishu/files";
import { PathFilter, assertSafeVaultPath } from "../src/sync/scanner";
import { assertPlanCurrent, isEditorDirty, planFingerprint, prepareTarget, validateLocalPaths } from "../src/sync/guards";
import { DEFAULT_SETTINGS, emptyState } from "../src/sync/types";
import { Logger } from "../src/log";

const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;
const response = (data: unknown, status = 200) => ({ status, text: JSON.stringify(data), arrayBuffer: new ArrayBuffer(0), headers: {} });
afterEach(() => { __setRequestUrlHandler(undefined); setRequestBudgetForTest(undefined); });

test("debug disabled does not emit note paths or write logs; errors are not duplicated", async () => {
  const original = { debug: console.debug, log: console.log, warn: console.warn, error: console.error };
  const messages: unknown[][] = [];
  for (const level of ["debug", "log", "warn", "error"] as const) console[level] = (...args) => { messages.push(args); };
  try {
    const log = new Logger(() => { throw new Error("must not access vault when debug disabled"); }, () => false);
    log.info("private-note.md");
    log.debug("private-endpoint");
    await log.flush();
    assert.equal(messages.length, 0);
    log.warn("warning");
    log.error("failure");
    assert.equal(messages.length, 2);
  } finally {
    Object.assign(console, original);
  }
});

test("glob ** includes root files, ? never crosses a directory", () => {
  const filter = new PathFilter("**/private.md\na?b.md");
  for (const file of ["private.md", "notes/private.md", "a/b/private.md", "axb.md"]) assert.ok(filter.isExcluded(file));
  assert.equal(filter.isExcluded("a/b.md"), false);
});

test("reject path traversal and ambiguous flat paths", () => {
  for (const path of ["../outside.md", "a/../b.md", "a\\..\\b.md", "/absolute.md", "C:/x.md", "a//b.md"]) {
    assert.throws(() => assertSafeVaultPath(path));
  }
  const settings = { ...DEFAULT_SETTINGS, folderMode: "flat" as const };
  assert.throws(() => validateLocalPaths(["a__b.md"], settings));
  validateLocalPaths(["a/b.md"], settings);
});

test("switching target or either sync mode resets all mappings", () => {
  for (const [from, to] of [["md", "doc"], ["doc", "md"], ["doc", "doc"]] as const) {
    const settings = { ...DEFAULT_SETTINGS, state: emptyState() };
    settings.state.target = { spaceId: "old", rootNodeToken: "", syncMode: from };
    settings.state.folders["notes"] = { nodeToken: "old-folder" };
    settings.state.images["token"] = { path: "old.png", token: "token", at: 0 };
    assert.ok(prepareTarget(settings, to === from ? "new" : "old", "", to));
    assert.deepEqual(settings.state.folders, {});
    assert.deepEqual(settings.state.images, {});
  }
});

test("preview invalidates after settings or mappings change; fingerprints contain no secrets", () => {
  const settings = { ...DEFAULT_SETTINGS, appSecret: "private-test-secret", state: emptyState() };
  const plan = { settingsFingerprint: planFingerprint(settings) } as never;
  assert.ok(!JSON.stringify(plan).includes(settings.appSecret));
  assertPlanCurrent(plan, settings);
  settings.state.lastSyncAt = Date.now();
  assertPlanCurrent(plan, settings);
  settings.excludePatterns = "notes/**";
  assert.throws(() => assertPlanCurrent(plan, settings), /重新预览/);
});

test("all open editors are checked, including a dirty second pane", async () => {
  const file = new TFile(); file.path = "note.md";
  const app = { vault: { getAbstractFileByPath: () => file, read: async () => "saved" },
    workspace: { getLeavesOfType: () => ["saved", "unsaved"].map(text => ({ view: { file, editor: { getValue: () => text } } })) } };
  assert.equal(await isEditorDirty(app as never, file.path), true);
});

test("uncertain JSON writes are not retried", async () => {
  for (const status of [500, 502]) {
    let calls = 0;
    __setRequestUrlHandler(async () => { calls++; return response({ code: 1, msg: "uncertain" }, status); });
    const client = new FeishuClient(async () => "test", logger);
    await assert.rejects(client.json("POST", "/open-apis/docs_ai/v1/documents", { body: {} }));
    assert.equal(calls, 1);
  }
});

test("write timeout never repeats or falls back to a second upload", async () => {
  let calls = 0;
  setRequestBudgetForTest(10);
  __setRequestUrlHandler(async () => { calls++; return new Promise(() => {}); });
  const client = new FeishuClient(async () => "test", logger);
  await assert.rejects(uploadMarkdownToWiki(client, { spaceId: "test", parentNode: "node", fileName: "a.md", data: new ArrayBuffer(1) }), /超时/);
  assert.equal(calls, 1);
});

test("disconnected writes are not retried either", async () => {
  let calls = 0;
  __setRequestUrlHandler(async () => { calls++; throw new Error("connection reset after sending"); });
  await assert.rejects(new FeishuClient(async () => "test", logger).json("POST", "/create", { body: {} }), /结果不确定/);
  assert.equal(calls, 1);
});

test("read retry does not rotate OAuth tokens", async () => {
  let calls = 0;
  const force: (boolean | undefined)[] = [];
  __setRequestUrlHandler(async () => ++calls === 1 ? response({ code: 1 }, 503) : response({ code: 0, data: { ok: true } }));
  const client = new FeishuClient(async refresh => { force.push(refresh); return "test"; }, logger);
  assert.deepEqual(await client.json("GET", "/read"), { ok: true });
  assert.deepEqual(force, [false, false]);
});

test("authentication refusal refreshes once", async () => {
  let calls = 0;
  const force: (boolean | undefined)[] = [];
  __setRequestUrlHandler(async () => ++calls === 1 ? response({ code: 99991663 }, 401) : response({ code: 0, data: {} }));
  const client = new FeishuClient(async refresh => { force.push(refresh); return "test"; }, logger);
  await client.json("GET", "/read");
  assert.deepEqual(force, [false, true]);
});

test("concurrent OAuth refresh requests share a single exchange", async () => {
  let calls = 0;
  let tokens = { accessToken: "expired", refreshToken: "one-time-refresh", accessExpiresAt: 0, refreshExpiresAt: Date.now() + 3600_000 };
  __setRequestUrlHandler(async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return response({ access_token: "new", refresh_token: "rotated", expires_in: 7200, refresh_token_expires_in: 3600 });
  });
  const auth = new AuthManager(() => ({ mode: "user", appId: "test", appSecret: "test", oauthScope: "", redirectUri: "http://localhost:7634/callback" }),
    () => tokens, async value => { tokens = value!; }, logger);
  assert.deepEqual(await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()]), ["new", "new", "new"]);
  assert.equal(calls, 1);
  assert.equal(tokens.refreshToken, "rotated");
});

test("authentication requests also have a response deadline", async () => {
  setRequestBudgetForTest(10);
  __setRequestUrlHandler(async () => new Promise(() => {}));
  const auth = new AuthManager(() => ({ mode: "tenant", appId: "test", appSecret: "test", oauthScope: "", redirectUri: "" }), () => undefined, async () => {}, logger);
  await assert.rejects(auth.getToken(), /没有响应/);
});

test("incomplete wiki responses and repeated cursors abort instead of implying deletion", async () => {
  for (const data of [{}, { items: [], has_more: true }, { items: [], has_more: true, page_token: "repeated" }]) {
    __setRequestUrlHandler(async () => response({ code: 0, data }));
    await assert.rejects(listNodes(new FeishuClient(async () => "test", logger), "space"), /items|分页/);
  }
});

test("depth limit aborts the entire scan", async () => {
  let index = 0;
  const client = { json: async () => ({ items: [{ node_token: `n${++index}`, obj_token: `d${index}`, obj_type: "docx", title: "nested", has_child: true }] }) };
  await assert.rejects(walkWikiTree(client as never, "space", undefined), /超过 20 层/);
});
