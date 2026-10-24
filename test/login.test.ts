/**
 * zero搬运网 账号登录流程测试
 *
 * 不接触真实账号：用明显不存在的账号验证「请求协议是否正确」——
 * 只要服务端返回的是「登录失败 / 密码错误」而不是「formhash 错误」，
 * 就说明 formhash / loginhash / 字段名 / 提交地址全部正确。
 *
 * 运行：npx tsx test/login.test.ts
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as cheerio from "cheerio";

(globalThis as unknown as { BreezeHtml: unknown }).BreezeHtml = {
  load: (html: string) => cheerio.load(html),
};

const require = createRequire(import.meta.url);
const plugin = require("../dist/breeze-plugin-zerobyw.bundle.cjs").default;

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

console.log("\n[zero搬运网 登录改造]");

await check("登录表单为账号密码（不再是 Cookie）", async () => {
  const bundle = await plugin.getLoginBundle();
  const keys = bundle.scheme.fields.map((f: { key: string }) => f.key);
  assert.deepEqual(keys, ["username", "password", "questionid", "answer"], keys.join(","));
  assert.equal(bundle.scheme.action.fnPath, "loginWithAccount");

  const passwordField = bundle.scheme.fields.find((f: { key: string }) => f.key === "password");
  assert.equal(passwordField.kind, "password", `kind=${passwordField.kind}`);
  assert.equal(bundle.scheme.fields[0].required, true);
});

await check("Cookie 登录作为备用入口保留", async () => {
  const bundle = await plugin.getCookieLoginBundle();
  const keys = bundle.scheme.fields.map((f: { key: string }) => f.key);
  assert.deepEqual(keys, ["cookie"]);
  assert.equal(bundle.scheme.action.fnPath, "loginWithCookie");

  const caps = await plugin.getCapabilitiesBundle();
  const fnPaths = caps.scheme.actions.map((a: { fnPath: string }) => a.fnPath);
  assert.ok(fnPaths.includes("getCookieLoginBundle"), fnPaths.join(","));
});

await check("空账号被拦截", async () => {
  let message = "";
  try {
    await plugin.loginWithAccount({ values: { username: "", password: "" } });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.ok(/不能为空/.test(message), message);
});

await check("假账号登录：协议走通，返回明确失败", async () => {
  let message = "";
  try {
    await plugin.loginWithAccount({
      values: { username: "breeze_probe_not_exist", password: "probe_invalid_2026" },
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.ok(message.length > 0, "应当抛错");
  // 关键断言：不是解析/表单参数层面的错误，而是服务端明确拒绝了账号
  assert.ok(!/formhash|loginhash/.test(message), `协议层出错: ${message}`);
  assert.ok(!/未能从登录页解析/.test(message), `页面解析失败: ${message}`);
  assert.ok(/失败|错误|不存在|密码|次数/.test(message), `错误信息不可读: ${message}`);
  console.log(`    服务端返回：${message}`);
});

await check("图标地址指向仓库资源", async () => {
  const info = await plugin.getInfo();
  assert.ok(info.iconUrl.includes("cdn.jsdelivr.net"), info.iconUrl);
  assert.ok(info.iconUrl.endsWith("assets/icon.png"), info.iconUrl);
  assert.equal(info.version, "1.2.0");
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed > 0 ? 1 : 0);
