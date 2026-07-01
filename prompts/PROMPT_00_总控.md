# PROMPT 00 - 总控
## 角色
你是 `Hacker News精选推送` 的总控 Agent，负责把「榜单抓取 -> HN 详情与评论 -> 外链摘要提取 -> 中文翻译 -> 静态网页生成 -> GitHub Pages 发布 -> Bark 推送 -> 测试验收」串成一条完整、可重复运行的交付链路。

## 目标
在一次实现任务中完成以下闭环：
1. 从 `https://news.ycombinator.com/best?h=24` 读取“过去 24 小时最佳”榜单的前 `50` 条帖子顺序。
2. 通过 HN Firebase API 获取每条帖子的结构化详情、正文信息和完整评论树。
3. 对外链文章提取正文摘要或要点；本轮不做外链全文翻译。
4. 将标题、HN `text` 正文、外链摘要、评论翻译成中文；代码块、命令、库名、API 名、产品名、URL、用户名、公司缩写和专业术语默认保留原文。
5. 生成移动端优先的静态网页：最新首页、每条帖子详情页、批次归档页和机器可读 `manifest.json`。
6. 通过 GitHub Actions 按北京时间 `08:00`、`12:00`、`15:00` 定时运行，发布到 GitHub Pages，并在发布成功后通过 Bark 推送链接到手机。
7. 输出可直接运行和维护的工程，包括环境变量样例、README、测试脚本、缓存与去重策略。

## 共享输入约定
```json
{
  "mode": "scheduled|manual",
  "timezone": "Asia/Shanghai",
  "slot": "08:00|12:00|15:00|manual",
  "listUrl": "https://news.ycombinator.com/best?h=24",
  "limit": 50,
  "historyDays": 7,
  "siteBaseUrl": "https://<github-user>.github.io/<repo>/",
  "articleSummaryMaxParagraphs": 5,
  "commentTranslationCharBudget": 220000,
  "bark": {
    "server": "https://api.day.app",
    "deviceKeysEnv": "BARK_DEVICE_KEYS"
  },
  "openai": {
    "apiKeyEnv": "OPENAI_API_KEY",
    "modelEnv": "OPENAI_MODEL"
  }
}
```

字段规则：
- `mode`：允许 `scheduled | manual`；本地调试和 `workflow_dispatch` 用 `manual`。
- `timezone`：固定 `Asia/Shanghai`，所有页面、日志、批次号和推送文案都展示北京时间。
- `slot`：定时运行时只能是 `08:00`、`12:00`、`15:00`；手动运行允许 `manual`。
- `limit`：固定 `50`，不做分页。
- `historyDays`：固定保留最近 `7` 天的批次页面；旧批次自动清理。
- `siteBaseUrl`：站点绝对基地址，Bark 推送链接和页面 canonical 都以它为准。
- `articleSummaryMaxParagraphs`：外链摘要最多 `5` 段或等价要点，保持适合手机阅读。
- `commentTranslationCharBudget`：单批评论翻译总预算默认 `220000` 个原始字符；超过预算时允许部分评论保留原文并标记未翻译。

环境变量要求：
- `OPENAI_API_KEY`：必填。
- `OPENAI_MODEL`：必填，不在代码里硬编码默认模型。
- `SITE_BASE_URL`：必填。
- `BARK_DEVICE_KEYS`：必填，支持单个或多个 device key，多个值用英文逗号分隔。
- `BARK_SERVER`：可选，默认 `https://api.day.app`。
- `GITHUB_TOKEN`：GitHub Actions 提交生成产物与部署 Pages 时使用。

## 默认技术决策
- 运行时固定为 `Node.js 20+`。
- 语言固定为 `TypeScript`，包管理固定为 `npm`。
- 榜单排序固定来自 `best?h=24` 页面，只用于提取前 `50` 条帖子 id 与顺序，不把网页 DOM 作为详情主数据源。
- 帖子详情与评论数据固定来自 HN Firebase API：`https://hacker-news.firebaseio.com/v0/item/<id>.json`。
- 外链文章摘要提取固定使用 `jsdom + @mozilla/readability`；无法提取时保留原始链接，不因外链失败阻塞页面生成。
- 翻译接口固定使用 OpenAI API；翻译时先保护不可翻译片段，再做分段翻译，最后恢复占位符。
- 页面固定为静态 HTML + CSS + 少量原生 JavaScript，不引入 React、Vue 或服务端渲染。
- 状态持久化固定使用仓库内 JSON 文件，不引入数据库；缓存、去重和推送记录都保存在 `state/`。
- GitHub Pages 通过 GitHub Actions 发布；生成结果放在 `dist/`，最新运行会回写 `dist/` 与 `state/` 到仓库默认分支。
- 定时任务固定使用 UTC cron：`0 0,4,7 * * *`，分别对应北京时间 `08:00`、`12:00`、`15:00`。

## 编排步骤
1. 规范化输入并生成 `RunConfig`，计算北京时间批次号 `batchId`，格式固定为 `YYYY-MM-DD-HHmm`，例如 `2026-03-22-0800`。
2. 请求 `https://news.ycombinator.com/best?h=24`，解析页面中前 `50` 条帖子 id，保留页面原始顺序作为最终展示顺序。
3. 通过 HN Firebase API 拉取每条帖子详情，补齐 `title`、`url`、`score`、`author`、`time`、`descendants`、`kids` 等字段，并递归获取完整评论树。
4. 对 `type = story` 且存在外链 `url` 的帖子抓取文章 HTML，用 `Readability` 提取正文后生成英文摘要 `summaryRaw`；对 `Ask HN`、`Show HN` 等 HN 文本帖直接保留 `textRawHtml`。
5. 对标题、HN 文本帖正文、外链摘要、评论做翻译：
   - HTML 内容按 DOM 节点遍历，只翻译文本节点，保留 `a`、`code`、`pre`、`p`、`ul`、`ol`、`li`、`blockquote` 等结构。
   - 代码块、内联代码、链接 URL、用户名、产品名、库名、API 名、公司缩写和专业术语使用占位符保护。
   - 评论按广度优先顺序翻译，优先保证顶层和浅层评论有中文版本。
6. 读取并更新 `state/translation-cache.json`、`state/push-history.json`、`state/batches.json`：
   - 去重键固定为 `story:<id>:<contentHash>` 或 `comment:<id>:<contentHash>`。
   - 若缓存命中则复用历史译文，不重复调用翻译接口。
   - 若同一 `batchId` 已完成推送，则禁止重复 Bark 推送。
7. 渲染静态网页：
   - `dist/index.html` 指向最新批次。
   - `dist/batches/<batchId>/index.html` 展示本次前 `50` 条帖子列表。
   - `dist/stories/<storyId>.html` 生成每条帖子详情页。
   - `dist/batches/<batchId>/manifest.json` 输出本次机器可读索引。
8. 清理超过 `7` 天的旧批次页面与对应状态索引，保留最近 `21` 个计划批次的静态归档。
9. 运行测试：至少覆盖榜单解析、评论树构建、翻译保护规则、渲染结果和推送去重。
10. 若测试通过且有可部署产物，则提交 `dist/` 与 `state/` 到默认分支，随后部署 GitHub Pages。
11. Pages 发布成功后发送 Bark 通知，标题格式固定为 `HN 精选已更新 | <北京时间>`，正文说明“前 50 条帖子与评论翻译已生成”，链接指向本次批次首页。

## 中间数据契约
### `RunConfig`
```json
{
  "mode": "scheduled",
  "timezone": "Asia/Shanghai",
  "slot": "08:00",
  "batchId": "2026-03-22-0800",
  "listUrl": "https://news.ycombinator.com/best?h=24",
  "limit": 50,
  "historyDays": 7,
  "siteBaseUrl": "https://example.github.io/hn-digest/",
  "generatedAt": "2026-03-22T00:00:00.000Z",
  "commentTranslationCharBudget": 220000
}
```

### `StoryRecord`
```json
{
  "id": 12345678,
  "rank": 1,
  "type": "story",
  "title": "Original title",
  "titleZh": "中文标题",
  "url": "https://example.com/article",
  "domain": "example.com",
  "hnUrl": "https://news.ycombinator.com/item?id=12345678",
  "author": "pg",
  "score": 321,
  "publishedAt": "2026-03-21T23:10:00.000Z",
  "commentsCount": 128,
  "textRawHtml": "",
  "textZhHtml": "",
  "summaryRaw": [
    "Point 1",
    "Point 2"
  ],
  "summaryZh": [
    "要点 1",
    "要点 2"
  ],
  "translationStatus": "translated|partial|raw_only",
  "contentHash": "sha256",
  "comments": []
}
```

### `CommentNode`
```json
{
  "id": 23456789,
  "parentId": 12345678,
  "author": "dang",
  "publishedAt": "2026-03-21T23:15:00.000Z",
  "level": 1,
  "hnUrl": "https://news.ycombinator.com/item?id=23456789",
  "textRawHtml": "<p>Original comment</p>",
  "textZhHtml": "<p>中文评论</p>",
  "translationStatus": "translated|cached|skipped_budget|raw_only",
  "contentHash": "sha256",
  "children": []
}
```

### `BatchManifest`
```json
{
  "batchId": "2026-03-22-0800",
  "timezone": "Asia/Shanghai",
  "slot": "08:00",
  "generatedAt": "2026-03-22T00:00:00.000Z",
  "storyCount": 50,
  "latestIndexUrl": "https://example.github.io/hn-digest/",
  "batchUrl": "https://example.github.io/hn-digest/batches/2026-03-22-0800/",
  "stories": [
    {
      "id": 12345678,
      "rank": 1,
      "title": "Original title",
      "titleZh": "中文标题",
      "storyUrl": "https://example.github.io/hn-digest/stories/12345678.html",
      "hnUrl": "https://news.ycombinator.com/item?id=12345678",
      "sourceUrl": "https://example.com/article",
      "commentsCount": 128,
      "translationStatus": "translated"
    }
  ],
  "push": {
    "status": "pending|sent|failed|skipped_duplicate",
    "sentAt": "2026-03-22T00:05:00.000Z",
    "messageUrl": "https://example.github.io/hn-digest/batches/2026-03-22-0800/"
  }
}
```

## 输出要求
- 交付必须包含以下目录与文件：
  - `src/fetch/`：榜单抓取、HN API 获取、外链抓取。
  - `src/normalize/`：Story 与 Comment 结构标准化。
  - `src/translate/`：占位符保护、分段翻译、缓存复用。
  - `src/render/`：首页、详情页、批次页和静态资源生成。
  - `src/publish/`：状态写回、Pages 部署辅助、批次清理。
  - `src/notify/`：Bark 推送。
  - `state/`：翻译缓存、批次历史、推送记录。
  - `dist/`：静态网站产物。
  - `.github/workflows/hn-digest.yml`：定时任务与部署流程。
  - `.env.example`：环境变量样例。
  - `README.md`：本地运行、部署方式、故障排查。
- `package.json` 至少提供以下脚本：
  - `npm run sync`：执行一次完整抓取、翻译、渲染、状态更新。
  - `npm run build`：仅生成静态页面。
  - `npm run notify`：读取最新批次并执行 Bark 推送。
  - `npm run test`：运行测试。
- 首页交互固定为“HN 原站列表增强版”：
  - 展示前 `50` 条帖子，中文标题在前，英文原标题作为副标题保留。
  - 保留 `score / author / age / comments / domain` 元信息。
  - 每条帖子提供 `查看详情`、`打开 HN 原帖`、`打开原始文章` 三个入口；若无外链，则隐藏 `打开原始文章`。
- 详情页交互固定为：
  - 顶部展示中英标题、域名、作者、分数、评论数、发布时间和 HN 原帖链接。
  - 外链帖子正文区只展示中文摘要和原文摘要；HN 文本帖展示保留结构的中文正文，并提供 `查看原文` 切换。
  - 评论区保留树状结构；一级评论默认展开，二级及以下默认折叠。
  - 每条评论默认展示中文译文，并在同一位置提供 `查看原文` 与 `在 HN 中查看`。
  - 超长评论默认展示前 `4-6` 行，点击后展开完整内容。
- 页面必须移动端优先：
  - 单列布局，正文基准字号约 `16px`。
  - 评论缩进在手机端最多明显展示 `2-3` 级，超过层级通过细竖线与浅底色表示。
  - 所有操作按钮必须能单手点击，不依赖 hover。

## 约束
- 不允许直接解析 HN 页面 DOM 作为详情主数据源；只允许用 `best?h=24` 页面提取排序和 story id。
- 不允许做 PDF 方案，也不要求 PWA；本轮交付固定为响应式静态网页。
- 不允许外链全文翻译；外链只做摘要或要点提炼，并保留跳转原文入口。
- 不允许把评论平铺重排；必须保留 HN 的父子层级关系。
- 不允许把原文覆盖掉；原文与译文必须同时保留。
- 不允许翻译代码块、命令、API 名、库名、URL、用户名、公司缩写和专业术语；若不确定，优先保留原文。
- 翻译风格必须忠实、克制、不补充立场解释、不擅自总结成与原文不同的结论。
- 对 HN 返回的 HTML 必须先做安全清洗，再渲染到页面；同时要尽量保留原本段落、列表、引用和代码结构。
- 评论翻译超出预算时，必须优先保住顶层评论和浅层评论；未翻译节点展示原文并标记 `未翻译`，但整页生成与发布不能失败。
- 若外链抓取失败、单条评论翻译失败或 Bark 推送失败，只允许对应模块降级，不允许整批任务崩溃：
  - 外链失败：详情页仍展示标题、元信息、评论和原始文章链接。
  - 翻译失败：保留原文并写入失败状态。
  - Bark 失败：站点仍正常发布，并把失败记录写入 `state/push-history.json`。

## 测试与验收
- 单元测试至少覆盖：
  - `best?h=24` 排名解析与前 `50` 条截取。
  - HN API 数据映射与评论树构建。
  - 占位符保护与恢复，确保代码/术语/URL 未被误翻。
  - HTML 清洗后结构仍保留 `code`、`pre`、列表、引用等关键节点。
  - 批次号、去重键、Bark 去重逻辑。
- 集成测试至少覆盖：
  - `榜单抓取 -> HN API -> 翻译缓存 -> 页面渲染` 全链路。
  - 外链摘要抓取失败时的页面降级。
  - 同一 `batchId` 重跑时不会重复发送 Bark。
  - GitHub Actions 使用 UTC cron `0 0,4,7 * * *` 时，对应页面时间展示为北京时间 `08:00 / 12:00 / 15:00`。
- 端到端验收至少覆盖：
  - 最新首页能打开并展示 `50` 条帖子。
  - 任意详情页能看到中文内容、原文切换、HN 原帖跳转和评论折叠。
  - Bark 推送中的链接可直接打开本次批次页。
  - 历史批次可回看，旧批次会按 `7` 天策略清理。

## 完成标准
- 下游实现者无需重新决定数据源、调度时区、页面形式、缓存策略、翻译保护规则、推送方式或验收标准。
- 工程在本地可手动运行一次完整流程，在 GitHub Actions 中可按计划稳定运行。
- 生成结果可直接在手机上阅读，评论区保留 HN 层级结构，并支持原文切换与原帖跳转。
- 重复执行不会导致大规模重复翻译或同批次重复 Bark 推送。
- README、环境变量样例和工作流配置足够完整，拿到仓库即可继续实现，而不是再写一份 PRD。
