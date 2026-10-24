/**
 * 域名自动发现测试
 *
 * 覆盖三件事：
 *   1. 从官方发布页正确解析候选域名（顺序 & 过滤）
 *   2. 域名失效时，列表请求能自动切到可用域名并成功返回
 *   3. 刷新 / 重置域名的 fnPath 行为
 *
 * 运行：npx tsx test/domain.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

(globalThis as unknown as { BreezeHtml: unknown }).BreezeHtml = {
  load: (html: string) => cheerio.load(html),
};

const here = dirname(fileURLToPath(import.meta.url));
const publisherHtml = readFileSync(resolve(here, "fixtures", "publisher.html"), "utf-8");

const { collectCandidates, discoverOrigin, PUBLISHER_URL } = await import("../src/site.ts");
const { getOrigin, setOrigin, resetOrigin, DEFAULT_ORIGIN, looksLikeSitePage, looksLikeParkedPage, deriveImageHost } =
  await import("../src/origin.ts");
const { default: plugin } = await import("../src/index.ts");

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => void | Promise<void>) {
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

console.log("\n[1] 发布页解析");

const candidates = collectCandidates(publisherHtml);

await check("发布页地址正确", () => {
  assert.equal(PUBLISHER_URL, "https://zerobyw.github.io/");
});

await check("能解析出候选域名", () => {
  assert.ok(candidates.length > 0, "候选为空");
});

await check("首个候选是当前最新域名", () => {
  // 发布页给的是 http://，协议在探测阶段才升级为 https
  assert.equal(new URL(candidates[0]).hostname, "www.zerobyw33.com", `实际=${candidates[0]}`);
});

await check("首候选与时间线最新一条一致", () => {
  // 时间线首条为 2026-06-13 更新的 zerobyw33
  assert.ok(candidates[0].includes("zerobyw33"), `首候选=${candidates[0]}`);
});

await check("全部候选属于站点族群", () => {
  assert.ok(candidates.every((item) => item.includes("zerobyw")), candidates.join(","));
});

await check("排除 github.io 自身", () => {
  assert.ok(!candidates.some((item) => item.includes("github.io")));
});

await check("候选已去重", () => {
  assert.equal(new Set(candidates).size, candidates.length);
});

await check("候选数量有上限", () => {
  assert.ok(candidates.length <= 8, `数量=${candidates.length}`);
});

console.log("\n[2] 页面特征判定");

await check("识别真实站点页", () => {
  assert.equal(looksLikeSitePage('<div class="pc-manga-grid"></div>'), true);
  assert.equal(looksLikeSitePage("zero搬运网"), true);
  assert.equal(looksLikeSitePage("<html><body>hello</body></html>"), false);
});

await check("识别域名停放页", () => {
  assert.equal(looksLikeParkedPage("<h1>This domain is for sale</h1>"), true);
  assert.equal(looksLikeParkedPage("<div>normal page</div>"), false);
});

await check("图片 CDN 域名推导", () => {
  assert.equal(deriveImageHost("www.zerobyw33.com"), "tupa.zerobyw33.com");
  assert.equal(deriveImageHost("zerobywb.com"), "tupa.zerobywb.com");
});

console.log("\n[3] 真实失效切换");

await check("能发现可用域名", async () => {
  const origin = await discoverOrigin();
  assert.ok(origin.startsWith("http"), `origin=${origin}`);
  assert.ok(origin.includes("zerobyw"), `origin=${origin}`);
});

await check("域名失效时列表请求自动恢复", async () => {
  // 故意指向一个不存在的域名
  setOrigin("https://www.zerobyw33-broken-domain.com");
  assert.equal(getOrigin(), "https://www.zerobyw33-broken-domain.com");

  const res = await plugin.getRankingData({ page: 1, extern: {} });
  assert.ok(res.data.items.length > 0, "切换后仍未拿到数据");

  const recovered = getOrigin();
  assert.notEqual(recovered, "https://www.zerobyw33-broken-domain.com", "域名未切换");
  assert.ok(recovered.includes("zerobyw"), `切换后=${recovered}`);
  console.log(`    失效域名 → 自动切换为 ${recovered}`);
});

await check("切换后详情页正常", async () => {
  const res = await plugin.getComicDetail({ comicId: "23140" });
  assert.ok(res.data.normal.comicInfo.title.includes("二度转生"), res.data.normal.comicInfo.title);
});

console.log("\n[4] 域名管理动作");

await check("refreshDomain 返回当前域名", async () => {
  const res = await plugin.refreshDomain();
  assert.equal(res.data.ok, true);
  assert.ok(String(res.data.origin).includes("zerobyw"), String(res.data.origin));
  assert.ok(typeof res.message === "string" && res.message.length > 0);
});

await check("resetDomain 回到内置默认", async () => {
  const res = await plugin.resetDomain();
  assert.equal(res.data.origin, DEFAULT_ORIGIN);
  assert.equal(getOrigin(), DEFAULT_ORIGIN);
});

await check("设置页展示当前域名", async () => {
  resetOrigin();
  const settings = await plugin.getSettingsBundle();
  const titles = settings.scheme.sections.map((s: { title: string }) => s.title);
  assert.ok(titles.some((t: string) => t.includes("当前域名")), titles.join(" | "));
});

await check("能力页包含域名操作", async () => {
  const caps = await plugin.getCapabilitiesBundle();
  const keys = caps.scheme.actions.map((a: { fnPath: string }) => a.fnPath);
  assert.ok(keys.includes("refreshDomain"), keys.join(","));
  assert.ok(keys.includes("resetDomain"), keys.join(","));
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed > 0 ? 1 : 0);
