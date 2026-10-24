/**
 * 离线解析回归测试
 *
 * 用真实抓取的页面 HTML 验证 parse 层的选择器与字段映射。
 * BreezeHtml 由宿主注入，这里用 cheerio 提供同构实现（API 子集一致）。
 *
 * 运行：npx tsx test/parse.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

// 必须在加载 parse 模块前注入全局
(globalThis as unknown as { BreezeHtml: unknown }).BreezeHtml = {
  load: (html: string) => cheerio.load(html),
};

const { parseComicList, parseComicDetail, parseReader, toChapterSummaries } = await import("../src/parse.ts");

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(resolve(here, "fixtures", name), "utf-8");

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("\n[1] 列表页 / 搜索结果页");
const listPage = parseComicList(fixture("list.html"), 1);
check("解析出 24 张卡片", () => assert.equal(listPage.cards.length, 24));
check("识别总页数 260", () => assert.equal(listPage.totalPages, 260));
check("卡片字段完整", () => {
  const card = listPage.cards[0];
  assert.equal(card.kuid, "23140");
  assert.ok(card.title.includes("二度转生"), `title=${card.title}`);
  assert.ok(card.coverUrl.startsWith("https://tupa."), `cover=${card.coverUrl}`);
  assert.ok(card.subtitle.includes("话"), `subtitle=${card.subtitle}`);
  assert.ok(card.detailUrl.includes("kuid=23140"));
});
check("卡片 kuid 无重复", () => {
  const ids = listPage.cards.map((c) => c.kuid);
  assert.equal(new Set(ids).size, ids.length);
});

const searchPage = parseComicList(fixture("search.html"), 1);
check("搜索结果非空", () => assert.ok(searchPage.cards.length > 0));
check("搜索结果命中关键词相关条目", () => {
  assert.ok(searchPage.cards.some((c) => c.title.includes("转生")));
});

console.log("\n[2] 详情页");
const detail = parseComicDetail(fixture("detail.html"), "23140");
check("标题取第一行", () => assert.ok(detail.title.includes("二度转生的少年"), `title=${detail.title}`));
check("副标题取剩余行", () => assert.ok(detail.subtitle.includes("1-56话"), `subtitle=${detail.subtitle}`));
check("作者解析", () => assert.equal(detail.author, "十一屋翠×イケシタ"));
check("分类解析", () => {
  assert.ok(detail.categories.includes("冒险"), `cats=${detail.categories.join(",")}`);
  assert.ok(detail.categories.includes("奇幻"));
});
check("语言属性解析", () => assert.deepEqual(detail.languages, ["一半中文一半生肉"]));
check("状态解析", () => assert.equal(detail.status, "连载中"));
check("收藏数", () => assert.equal(detail.likesCount, 10));
check("人气数", () => assert.equal(detail.viewsCount, 215));
check("封面为绝对地址", () => assert.ok(detail.coverUrl.startsWith("https://tupa."), detail.coverUrl));
check("简介非空", () => assert.ok(detail.description.length > 10));
check("首个章节 id", () => assert.equal(detail.firstChapterId, "715941"));
check("finished 为 false", () => assert.equal(detail.finished, false));

console.log("\n[3] 阅读页");
const reader = parseReader(fixture("view.html"), "715941");
check("解析出 24 张图", () => assert.equal(reader.imageUrls.length, 24));
check("图片地址补全为 https", () => assert.ok(reader.imageUrls[0].startsWith("https://tupa."), reader.imageUrls[0]));
check("图片序号连续", () => assert.ok(reader.imageUrls[0].endsWith("/001.jpg") && reader.imageUrls[1].endsWith("/002.jpg")));
check("书名解析", () => assert.ok(reader.comicTitle.includes("二度转生"), `comicTitle=${reader.comicTitle}`));
check("章节名解析", () => assert.equal(reader.chapterName, "1"));
check("目录完整 31 话", () => assert.equal(reader.catalog.length, 31));
check("目录首项", () => assert.deepEqual(reader.catalog[0], { zjid: "715941", name: "1" }));
check("目录含区间章节名", () => assert.ok(reader.catalog.some((c) => c.name === "6-10")));
check("下一话 id", () => assert.equal(reader.nextChapterId, "715942"));
check("无上一话", () => assert.equal(reader.prevChapterId, ""));
check("未触发登录墙", () => assert.equal(reader.needLogin, false));

console.log("\n[4] 章节结构转换");
const chapters = toChapterSummaries(reader.catalog, "23140");
check("order 从 1 开始且连续", () => {
  assert.equal(chapters[0].order, 1);
  chapters.forEach((c, i) => assert.equal(c.order, i + 1));
});
check("requestId 与 zjid 一致", () => assert.equal(chapters[0].requestId, "715941"));
check("logicalKey 带漫画前缀", () => assert.equal(chapters[0].logicalKey, "23140-715941"));
check("storageChapterId 唯一", () => {
  const keys = chapters.map((c) => c.storageChapterId);
  assert.equal(new Set(keys).size, keys.length);
});

console.log("\n[5] 异常输入容错");
check("空页面不抛错", () => {
  const empty = parseComicList("<html></html>", 1);
  assert.equal(empty.cards.length, 0);
});
check("空页面详情兜底", () => {
  const empty = parseComicDetail("<html><body></body></html>", "1");
  assert.equal(empty.comicId, "1");
  assert.equal(empty.firstChapterId, "");
});
check("空页面阅读兜底", () => {
  const empty = parseReader("<html><body></body></html>", "9");
  assert.equal(empty.imageUrls.length, 0);
  assert.equal(empty.needLogin, false);
});
check("导航按钮不被识别为章节", () => {
  const html = `<html><body>
    <a href="/pc/view/index.php?zjid=1">下一话</a>
    <a href="/pc/view/index.php?zjid=2">上一话</a>
    <a href="/pc/view/index.php?zjid=3">3</a>
    <a href="/pc/view/index.php?zjid=4">10-20</a>
  </body></html>`;
  const parsed = parseReader(html, "3");
  assert.deepEqual(
    parsed.catalog.map((c) => c.zjid),
    ["3", "4"],
  );
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed > 0 ? 1 : 0);
