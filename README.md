# Breeze 插件：zero搬运网（zerobyw33）

给 [Breeze](https://github.com/deretame/Breeze) 漫画阅读器写的漫画源插件，目标站 `https://www.zerobyw33.com`。

按 Breeze 官方插件规范实现（`breeze-plugin-kit` + QuickJS 运行时 + `BreezeHtml` 原生解析），不依赖任何第三方解析库。

- 仓库：<https://github.com/k623615746/Breeze-plugin-zerobyw>
- 版本：1.1.0

---

## 安装

### 方式一：插件商店（推荐）

仓库名符合 Breeze 的收录规范（`Breeze-plugin-` 前缀 + 公开仓库 + 根目录有 `manifest.json`），
客户端会扫描 GitHub 后自动收录。入库通常在 **2~4 小时**内完成，之后可在
**发现页 → 插件 → 商店** 中搜索「zero搬运网」安装。

### 方式二：本地安装

下载 [Releases](https://github.com/k623615746/Breeze-plugin-zerobyw/releases/latest) 里的
`breeze-plugin-zerobyw.bundle.cjs`，然后：
**发现页 → 插件 → 设置 → 插件管理 → 更新 → 从本地安装**。

### 方式三：网络安装

在同一个「更新」对话框选「从网络安装」，填入 Release 资产直链：

```
https://github.com/k623615746/Breeze-plugin-zerobyw/releases/download/1.0.0/breeze-plugin-zerobyw.bundle.cjs
```

### 产物说明

| 文件 | 用途 |
| --- | --- |
| `dist/breeze-plugin-zerobyw.bundle.cjs` | 插件本体，本地/网络安装用 |
| `dist/breeze-plugin-zerobyw.bundle.cjs.br` | Brotli 压缩版，自动更新优先拉这个 |
| `manifest.json` | 插件元信息，商店扫描与自动更新依赖它 |

### 自动更新

`getInfo` 与 `manifest.json` 均已配置 `updateUrl` 指向 GitHub Release API，因此支持自动更新：
客户端启动后会静默比对版本，**远端版本号大于本地**时才下载安装。

发新版本流程：改 `src/get-info.ts` 里的 `version` → 重新构建 → 提交推送 →
建一个 **tag 与 version 完全一致** 的 Release（如 `1.0.0`，别加 `v` 前缀以免版本比对不一致），
把 `dist/` 两个产物和 `manifest.json` 一起上传。

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
| 域名自愈 | 域名失效时自动从官方发布页获取最新域名并切换 |

### 章节列表为什么单独处理

详情页只把前 5 话渲染成真实链接，其余章节是 `onclick="showLockTip('login')"` 的占位块。但**阅读页的目录弹层**会输出完整章节（本例 31 项），所以插件走的是：

```
详情页（拿元信息 + 首个 zjid）
  → 阅读页（解析目录弹层，拿完整章节列表）
```

这样即使未登录，也能看到完整话数，点开受限章节时会提示登录，而不是整个目录残缺。

---

## 域名自动切换

这个站的域名换得很勤（`zerobyw33` → `zerobywb` → `zerobywai` …），官方在
<https://zerobyw.github.io/> 维护了一张「永久发布页」，按时间倒序记录每次更新。

插件内置了自愈机制，**域名挂了不需要手动改代码**：

```
请求失败（DNS 失败 / 连接重置 / 404 / 命中停放页）
  → 抓发布页 https://zerobyw.github.io/
  → 收集候选：顶部「镜像」按钮 > 时间线各条「点击进入」
  → 逐个探测 /pc/pc/ 是否为真实站点页（https 优先，回落 http）
  → 第一个通过的即最新域名 → 持久化 → 用新域名重试原请求
```

几个实现细节：

- **不是简单取第一个链接**。发布页的候选里混着论坛、发卡网、广告外链，所以先按
  host 含 `zerobyw` 过滤并排除 `github.io` 自身，再按「镜像按钮 > 点击进入 > 其它」排序。
- **必须验证，不能只信顺序**。发布页的第一条有时还没更新，所以每个候选都实测
  `/pc/pc/` 返回的 HTML 是否含 `pc-manga-grid` 等站点特征，同时排除停放页特征
  （`domain is for sale` / `域名出售`）。
- **图片 CDN 跟着换**。图片在 `tupa.<主域名>`，主站换域后原图片地址会失效，
  下载失败时按当前主域名推导新 CDN 域名重试。
- **持久化**。新域名写入插件配置（`site.origin`），重启后直接生效，不必每次探测。

设置页会显示「当前域名」，底部提供两个手动动作：

| 动作 | 作用 |
| --- | --- |
| 刷新域名 | 立即抓发布页重新探测 |
| 重置为内置默认域名 | 回到 `www.zerobyw33.com` |

> 发布页本身在 `github.io`，如果你所在网络访问不了它，自愈会失败并沿用当前域名，
> 此时需要手动在设置里刷新，或等网络恢复。

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
  origin.ts   # 域名状态：默认/当前/归一化、站点特征判定、CDN 域名推导
  site.ts     # 域名发现：抓发布页 → 候选 → 探测 → 持久化
  common.ts   # 常量（分类表、UA）、HTML 实体解码、URL 归一化、图片/元信息构造
  http.ts     # fetch 封装：UA/Referer/Cookie、超时、二进制透传头、失效自动换域重试
  parse.ts    # BreezeHtml 解析：列表 / 详情 / 阅读页 / 目录
  get-info.ts # 插件注册信息 + manifest 生成
  index.ts    # 18 个 fnPath 实现
```

实现的 fnPath：

`init` `getInfo` `searchComic` `getRankingData` `getRankingFilterBundle` `getComicDetail` `getReadSnapshot` `getChapter` `fetchImageBytes` `getDownloadConcurrency` `getSettingsBundle` `getLoginBundle` `loginWithCookie` `clearCookieAction` `checkLoginState` `refreshDomain` `resetDomain` `getCapabilitiesBundle`

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

# 域名发现（发布页解析 + 真实失效切换）
npx tsx test/domain.test.ts    # 18 项

# 端到端（真实请求站点，含图片下载与 JPEG 头校验）
npx tsx test/e2e.test.ts       # 10 项
```

`test/fixtures/` 里是真实抓取的列表页 / 详情页 / 阅读页 / 搜索页 HTML，站点改版后先跑 `parse.test.ts` 就能快速定位是哪一层选择器挂了。

---

## 已知限制

- **章节内容受站点登录墙限制**，未登录只能读免费章节，这是站点策略，插件不做绕过。
- 站点无公开点赞/评论 API，`allowLike` / `allowComments` 已置 `false`。
- 只解析 HTML，站点若改成前端渲染（JSON 接口），需要改 `parse.ts`。
- 域名会自动跟随发布页切换；内置默认域名为 `www.zerobyw33.com`（见 `src/origin.ts` 的 `DEFAULT_ORIGIN`）。

---

## 声明

本项目仅为页面解析的技术实现，不存储、不缓存、不分发任何漫画内容，所有图片均从原站实时获取。

站点内容多为未经授权的搬运 / 汉化作品，版权归原作者及出版方所有。请自行判断使用行为的合规性，建议支持正版。
