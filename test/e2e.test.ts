/**
 * 端到端冒烟测试：直接加载构建产物，真实请求站点。
 * 用 cheerio 顶替宿主注入的 BreezeHtml。
 *
 * 运行：npx tsx test/e2e.test.ts
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as cheerio from "cheerio";

(globalThis as unknown as { BreezeHtml: unknown }).BreezeHtml = {
  load: (html: string) => cheerio.load(html),
};

const require = createRequire(import.meta.url);
const bundle = require("../dist/breeze-plugin-zerobyw.bundle.cjs");
const plugin = bundle.default ?? bundle;

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("\n[E2E] 真实网络调用");

await check("getInfo 返回注册信息", async () => {
  const info = await plugin.getInfo();
  assert.equal(info.name, "zero搬运网");
  assert.match(info.version, /^\d+\.\d+\.\d+$/);
  assert.ok(info.function.length >= 2, `function=${info.function.length}`);
});

await check("getRankingData 拉取列表", async () => {
  const res = await plugin.getRankingData({ page: 1, extern: {} });
  assert.ok(res.data.items.length > 0, "列表为空");
  const first = res.data.items[0];
  assert.ok(first.id && first.title, `id=${first.id} title=${first.title}`);
  assert.ok(first.cover.url.startsWith("https://"), first.cover.url);
  assert.equal(res.data.hasReachedMax, false);
});

await check("getRankingData 分类筛选生效", async () => {
  const res = await plugin.getRankingData({ page: 1, extern: { categoryId: "6" } });
  assert.ok(res.data.items.length > 0);
});

await check("searchComic 搜索", async () => {
  const res = await plugin.searchComic({ keyword: "转生", page: 1 });
  assert.ok(res.items.length > 0, "搜索无结果");
  assert.ok(res.items.some((item: { title: string }) => item.title.includes("转生")));
});

await check("searchComic 空关键词", async () => {
  const res = await plugin.searchComic({ keyword: "", page: 1 });
  assert.equal(res.items.length, 0);
  assert.equal(res.paging.hasReachedMax, true);
});

await check("getRankingFilterBundle 筛选项齐全", async () => {
  const res = await plugin.getRankingFilterBundle();
  const keys = res.scheme.fields.map((f: { key: string }) => f.key);
  assert.deepEqual(keys, ["category", "progress", "language", "sort"]);
});

await check("getComicDetail 详情 + 完整目录", async () => {
  const res = await plugin.getComicDetail({ comicId: "23140" });
  const normal = res.data.normal;
  assert.ok(normal.comicInfo.title.includes("二度转生"), normal.comicInfo.title);
  assert.ok(normal.eps.length >= 20, `章节数=${normal.eps.length}`);
  assert.equal(normal.eps[0].requestId, "715941");
  assert.ok(normal.allowDownload === true);
});

await check("getReadSnapshot 阅读页图片", async () => {
  const res = await plugin.getReadSnapshot({ comicId: "23140", chapterId: "715941" });
  const pages = res.data.chapter.pages;
  assert.equal(pages.length, 24, `页数=${pages.length}`);
  assert.ok(pages[0].url.startsWith("https://"), pages[0].url);
  assert.ok(res.data.chapters.length >= 20);
  assert.ok(res.data.comic.title.includes("二度转生"), res.data.comic.title);
});

await check("fetchImageBytes 下载真实图片", async () => {
  const detail = await plugin.getComicDetail({ comicId: "23140" });
  const res = await plugin.getReadSnapshot({ comicId: "23140", chapterId: "715941" });
  void detail;
  const bytes = await plugin.fetchImageBytes({ url: res.data.chapter.pages[0].url });
  assert.ok(bytes instanceof Uint8Array, typeof bytes);
  assert.ok(bytes.length > 10000, `字节数=${bytes.length}`);
  // JPEG 魔数
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
});

await check("设置页与登录表单可用", async () => {
  const settings = await plugin.getSettingsBundle();
  assert.equal(settings.data.canLogin, true);
  const login = await plugin.getLoginBundle();
  assert.equal(login.scheme.action.fnPath, "loginWithAccount");
  const keys = login.scheme.fields.map((f: { key: string }) => f.key);
  assert.deepEqual(keys, ["username", "password", "questionid", "answer"]);
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed > 0 ? 1 : 0);
