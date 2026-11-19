# Changelog

## 0.2.1

- 修复：`sleep` 被误写进 `animations.events`，导致整块 `animations` 被 dsh-pet 判为非法而回退默认动作名——自定义宠物因此找不到素材、桌面上变成空白。现在 `sleep` 正确放在 `animations` 顶层。

## 0.2.0

- 新增「AI 生成 Q 版」：接任意 OpenAI 兼容的 `POST {baseUrl}/images/edits`（`imageBaseUrl` / `imageModel` / `imageApiKey`，或环境变量 `PET_STUDIO_IMAGE_BASE_URL` / `PET_STUDIO_IMAGE_MODEL` / `PET_STUDIO_IMAGE_KEY`）；未配置时按钮不出现。
- 生成结果在浏览器里直接抠图，再走宠物包 + 动作生成，全程不落第三方存储。
- 动作生成提速：渲染画布 760px、VP9 realtime、单管线渲染，七段全量从 9m34s 降到约 2m25s。

## 0.1.0

- 首个版本：照片/立绘 → 本地抠图 → 512 头像 → dsh-pet 宠物包 → 自动登记实例。
- 程序化动作：用 sharp 逐帧变换 + ffmpeg 编码 VP9(alpha)，生成 idle / walk / turn / drag / click / sleep / whisper 七段，并把 `animations` 配置写进宠物包，覆盖待机、转向、拖拽、点击、移动、睡觉、碎碎念、工作状态与余额事件。
- 依赖缺失时降级：没有 sharp 或 ffmpeg 时只写宠物包（头像 + 人设），不改动画配置。
