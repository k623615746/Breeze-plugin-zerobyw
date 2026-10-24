# Breeze 插件：zero搬运网（zerobyw33）

给 [Breeze](https://github.com/deretame/Breeze) 漫画阅读器写的漫画源插件，目标站 `https://www.zerobyw33.com`。

按 Breeze 官方插件规范实现（`breeze-plugin-kit` + QuickJS 运行时 + `BreezeHtml` 原生解析），不依赖任何第三方解析库。

---

## 安装

产物在 `dist/`：

| 文件 | 用途 |
| --- | --- |
| `breeze-plugin-zerobyw.bundle.cjs` | **本地安装用**（Breeze → 发现页 → 插件 → 设置 → 插件管理 → 更新 → 从本地安装） |
| `breeze-plugin-zerobyw.bundle.cjs.br` | 同上，Brotli 压缩版，体积更小 |
| `manifest.json` | 发布/上架到插件列表时用 |

本插件未发布到 GitHub / npm，`getInfo` 里没有 `npmName` / `updateUrl`，因此**不支持自动更新**，升级需手动重装 bundle。

---

## 功能

| 功能 | 说明 |
| --- | --- |
| 发现页入口 | 全部漫画 / 人气排行 / 最新上架，共 3 个入口 |
| 搜索 | 关键词搜索，服务端分页 |
| 分类筛选 | 15 个分类（卖肉/后宫/冒险/奇幻/搞笑/日常/职业/体育/战斗/爱情/机战/悬疑/美食/百合/等网源） |
| 进度筛选 | 连载中 / 已完结 |
| 语言筛选 | 全中文 / 全生肉 / 一半中文一半生肉 |
| 排序 | 最新上架 / 最早上架 / 人气最高 / 收藏最多 |
| 详情页 | 标题、作者、分类、语言、状态、收藏数、人气数、简介、封面 |
| 章节列表 | **完整目录**（见下方说明） |
| 阅读 | 全部内页图片，支持下载 |
| 登录 | Cookie 登录，解锁受限章节 |

### 章节列表为什么单独处理

详情页只把前 5 话渲染成真实链接，其余章节是 `onclick="showLockTip('login')"` 的占位块。但**阅读页的目录弹层**会输出完整章节（本例 31 项），所以插件走的是：

```
详情页（拿元信息 + 首个 zjid）
  → 阅读页（解析目录弹层，拿完整章节列表）
```

这样即使未登录，也能看到完整话数，点开受限章节时会提示登录，而不是整个目录残缺。

---

## 登录（可选）

站点大部分章节需要登录账号。插件支持 Cookie 登录，**不需要账号密码**：

1. 浏览器登录 `zerobyw33.com`
2. F12 → 网络 → 任选一个请求 → 复制请求头里的 `Cookie`
3. Breeze → 该插件 → 设置 → 账号登录 → 粘贴 → 保存并验证

Cookie 只保存在本机插件配置（`authConfig`，Key 为 `auth.cookie`），不上传任何服务器。设置页底部提供「检查登录状态」和「清除登录 Cookie」两个操作。

未登录时：免费章节正常阅读，受限章节会抛标准 `unauthorized` 错误，宿主会弹出登录引导。

---

## 技术实现

```
src/
  common.ts   # 常量（分类表、域名、UA）、HTML 实体解码、URL 归一化、图片/元信息构造
  http.ts     # fetch 封装：UA/Referer/Cookie、超时、二进制透传头
  parse.ts    # BreezeHtml 解析：列表 / 详情 / 阅读页 / 目录
  get-info.ts # 插件注册信息 + manifest 生成
  index.ts    # 16 个 fnPath 实现
```

实现的 fnPath：

`init` `getInfo` `searchComic` `getRankingData` `getRankingFilterBundle` `getComicDetail` `getReadSnapshot` `getChapter` `fetchImageBytes` `getDownloadConcurrency` `getSettingsBundle` `getLoginBundle` `loginWithCookie` `clearCookieAction` `checkLoginState` `getCapabilitiesBundle`

几个关键点：

- **图片地址补全**：站点返回 `//tupa.zerobyw33.com/...` 或 `http://` 绝对地址，统一升级成 `https://`，避免宿主混合内容拦截。
- **二进制透传**：`fetchImageBytes` 必须带 `x-rquickjs-host-offload-binary-v1: 1`，否则图片数据会被字符串化导致解码失败。
- **章节名过滤**：目录里混有「上一话 / 下一话 / 返回」等导航链接，用正则只保留 `1`、`6-10` 这类章节名，避免污染目录。
- **`createActionItem` / `creator.onTap`** 用 `null` 而非 `{}`，匹配 `ComicInfoPageAction | null` 类型。

---

## 构建与测试

环境：Node 22+，本机用 npm（未装 pnpm）。

```bash
npm install

# 类型检查
npx tsc --noEmit

# 生成 manifest + 打包 + Brotli
npx tsx build/generate-manifest.ts
npx rspack build
npx tsx build/generate-brotli.ts

# 离线解析回归（用真实抓取页面，cheerio 顶替 BreezeHtml）
npx tsx test/parse.test.ts     # 37 项

# 端到端（真实请求站点，含图片下载与 JPEG 头校验）
npx tsx test/e2e.test.ts       # 10 项
```

`test/fixtures/` 里是真实抓取的列表页 / 详情页 / 阅读页 / 搜索页 HTML，站点改版后先跑 `parse.test.ts` 就能快速定位是哪一层选择器挂了。

---

## 已知限制

- **章节内容受站点登录墙限制**，未登录只能读免费章节，这是站点策略，插件不做绕过。
- 站点无公开点赞/评论 API，`allowLike` / `allowComments` 已置 `false`。
- 只解析 HTML，站点若改成前端渲染（JSON 接口），需要改 `parse.ts`。
- 域名可能更换（`zerobyw33` 的数字后缀会变），换域名时改 `common.ts` 里的 `SITE_ORIGIN` / `IMAGE_ORIGIN` 即可。

---

## 声明

本项目仅为页面解析的技术实现，不存储、不缓存、不分发任何漫画内容，所有图片均从原站实时获取。

站点内容多为未经授权的搬运 / 汉化作品，版权归原作者及出版方所有。请自行判断使用行为的合规性，建议支持正版。
