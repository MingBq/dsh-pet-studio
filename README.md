# dsh-pet-studio

把一张**照片或 Q 版立绘**变成 [dsh-pet](https://www.npmjs.com/package/dsh-pet) 能直接用的宠物包：本地抠图 → 512 头像 → 人设 → 自动登记实例。**内置宠物照常可用**——本插件不接管 dsh-pet 的渲染，只是往它的用户目录写宠物包。

## 能力

| 能力 | 说明 |
|---|---|
| 本地抠图 | 浏览器 canvas 四边泛洪填充去背景，图片**不上传**任何第三方 |
| 头像 | 自动裁到主体外接框、居中缩成 512×512 PNG |
| 人设 | 可自定义；留空用默认「说人话、短句、不说自己是 AI」 |
| 实例登记 | 写进 `~/.dsh/dsh-pet/main-config.jsonc` 的 `pets[]`（幂等，写前 `.bak`） |
| **整套动作** | 用 sharp 逐帧变换 + ffmpeg 编码 VP9(alpha)，生成 7 段动作并写入宠物包 |
| 内置宠物 | 完全不受影响，继续用它自己的动画与配置 |

### 生成的 7 段动作

| 文件 | 用在 |
|---|---|
| `idle.webm` | 待机呼吸、余额事件、随机小动作 |
| `walk.webm` | 移动、工作状态（忙碌） |
| `turn.webm` | 转向 |
| `drag.webm` | 被拖拽 |
| `click.webm` | 点击回应、完成庆祝 |
| `sleep.webm` | 睡觉（开始/循环/醒来） |
| `whisper.webm` | 碎碎念、思考/等待气泡 |

宠物包的 `animations` 会被整体重写为这七段（`idle / turn / drag / clicks / moves / categories / events / sleep`），
所以 dsh-pet 的睡觉、碎碎念、工作状态、余额事件都会落到**你自己的角色**上。

**耗时**：本机（Intel Mac，i5 级）七段全量生成约 **2.5 分钟**；CPU 越好越快。生成期间设置页会停在「处理中」，完成后刷新页面即可看到新动作。

**依赖**：`sharp`（必需，npm 直接装）+ ffmpeg（任选其一：`@ffmpeg-installer/ffmpeg` 可选依赖、系统 `ffmpeg`、
或环境变量 `FFMPEG_PATH` / `DSH_PET_STUDIO_FFMPEG`）。两者缺一时宠物包仍会写入，只是不生成动作。



## 安装

```sh
dsh plugin --profile web add dsh-pet-studio
```

装完打开 **设置 → 插件 → 宠物工坊**（或插件页里的同名标签），选图 → 生成宠物包 → 刷新页面，在 **设置 → 桌宠配置 → 种类** 里选新宠物。

## AI 生成 Q 版（可选）

插件不绑定任何图像厂商：任何 **OpenAI 兼容** 的 `POST {baseUrl}/images/edits` 都能用。

```yaml
# cordis.patch.yml 里给本插件行的 config
- insert:
    - id: pet-studio
      name: dsh-pet-studio
      config:
        imageBaseUrl: 'https://api.openai.com/v1'
        imageModel: 'gpt-image-1'
        # imageApiKey: 'sk-...'        # 也可以用环境变量
```

或用环境变量（推荐，避免明文写配置）：`PET_STUDIO_IMAGE_BASE_URL` / `PET_STUDIO_IMAGE_MODEL` / `PET_STUDIO_IMAGE_KEY`。

没配置时「AI 生成 Q 版」按钮不会出现，只保留「导入现成图」这条路径——不会假装能用。

## 边界（v0.2）

- **动作是程序化生成的**：七段循环由一张静态图变换而来（呼吸、摇摆、回弹、倾倒），不是 AI 逐动作生成的视频；胜在零额外成本、离线可用。
- 表情包目录（`pet/<id>-memes/`）与 `memes` 映射宿主已支持写入，但本版 UI 还没做上传（下一步）。
- 抠图对「背景干净、主体完整」的图效果最好；复杂背景建议先自己抠好再用。

## 自测

宿主在跑、插件已装的情况下：

```sh
node test/smoke.mjs             # 状态 + 建包 + 清理（约 1 秒）
node test/smoke.mjs --animate   # 再跑一次完整七段动作生成（约 2–4 分钟）
```

## 发布

```sh
npm publish            # 需要 npm 账号与 token
```

包名 `dsh-pet-studio` 若已被占用，改成自己的 scope，例如 `@yourname/dsh-pet-studio`，同时改 `package.json` 的 `name` 与 `cordis.patch.yml` 里的 `name`。

## License

MIT
