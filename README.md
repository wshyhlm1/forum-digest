# AI/科技论坛日报

这是一个“夜间数据快照层 + 静态发布层”的论坛日报项目。HN 优先使用官方 Firebase API 做周期快照，日报生成时消费前一天快照；V2EX/Linux.do 后续继续接入同一个静态站。

## HN 数据流

HN 不爬 HTML 榜单。快照任务使用官方接口：

```text
https://hacker-news.firebaseio.com/v0/topstories.json
https://hacker-news.firebaseio.com/v0/beststories.json
https://hacker-news.firebaseio.com/v0/item/<id>.json
```

每 2 小时记录一次：

```text
state/hn-snapshots/YYYY-MM-DD.json
```

每篇 story 会累计：

```text
score
descendants
bestRank
bestRankSource
firstSeenAt
lastSeenAt
appearances
observations[]
```

北京时间 00:17 合并前一天快照，生成日报。选择 00:17 是为了避开 GitHub Actions 整点高负载导致的延迟或丢任务风险。

## Hermes 读取入口

GitHub Pages artifact 仍上传 `dist/`，公开路径对应：

```text
dist/hn/latest.json
dist/hn/YYYY-MM-DD.json
dist/hn/YYYY-MM-DD.html
dist/hn/YYYY-MM-DD-full-comments.json
```

Hermes 早上优先读取：

```text
/hn/latest.json
```

`latest.json` 是轻量版：默认 HN top 20 stories，每篇只保留前 8 条高位评论。完整评论树在：

```text
/hn/YYYY-MM-DD-full-comments.json
```

完整站点仍会生成：

```text
dist/index.html
dist/batches/YYYY-MM-DD/index.html
dist/batches/YYYY-MM-DD/manifest.json
dist/stories/<source>-<id>.html
dist/stories/<source>-<id>.json
state/translation-cache.json
state/batches.json
```

## 配置

优先使用 Qwen/OpenAI-compatible 配置：

```text
QWEN_API_KEY
QWEN_BASE_URL
QWEN_MODEL
QWEN_EFFORT
SITE_BASE_URL
```

也兼容飞书/openclaw 风格：

```text
MKT_LLM_TRANSLATE_API_KEY
MKT_LLM_TRANSLATE_BASE_URL
MKT_LLM_TRANSLATE_MODEL
```

HN 相关：

```text
HN_SNAPSHOT_STORY_LIMIT=120
HN_DAILY_STORY_LIMIT=20
HN_PUBLIC_COMMENTS_PER_STORY=8
MAX_COMMENTS_PER_STORY=1000
```

## 本地运行

采样一次 HN 快照：

```bash
npm run snapshot:hn -- --mode manual
```

补采指定日期：

```bash
npm run snapshot:hn -- --mode manual --target-date 2026-07-01
```

生成指定日期日报：

```bash
npm run sync -- --mode manual --target-date 2026-07-01 --skip-push
```

## GitHub Pages

在仓库 Settings -> Pages 中选择 GitHub Actions，并设置 `SITE_BASE_URL`，例如：

```text
https://<user>.github.io/<repo>/
```

workflow 包含两个定时：

```text
37 1-23/2 * * *   HN 快照，每 2 小时一次
17 16 * * *       北京时间 00:17 生成前一天日报
```

Linux.do 如果公开 JSON 被 403 拦截，会返回空结果并继续生成其他来源。
