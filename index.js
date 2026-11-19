/**
 * dsh-pet-studio —— 把一张图做成 dsh-pet 能直接用的宠物包。
 *
 * 它只做「素材与宠物包」这一层：抠图后的头像、表情包、人设、实例注册。
 * 动画由 dsh-pet 自己渲染，内置宠物完全不受影响——本插件不接管它的渲染，
 * 只往它的用户目录 `~/.dsh/dsh-pet/pet/` 里写宠物包。
 *
 * 路由（同源，均由宿主 webServer 暴露）：
 *   GET  /plugins/dsh-pet-studio/api/status
 *   POST /plugins/dsh-pet-studio/api/pack
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { buildAnimations, animationConfig, resolveFfmpeg, ffmpegUsable, fileExists } from './lib/animate.js';

export const name = 'pet-studio';
export const inject = ['webServer'];

const BASE = '/plugins/dsh-pet-studio';
const MAX_BODY = 16 * 1024 * 1024;     // 头像 + 表情包 base64 的总预算
const MAX_FILE = 2 * 1024 * 1024;      // 单个文件解码后上限

const ID_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;

const json = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');
const petRoot = () => join(dshHome(), 'dsh-pet');
const petDir = () => join(petRoot(), 'pet');
const mainConfigPath = () => join(petRoot(), 'main-config.jsonc');

const ensureDir = (dir) => { mkdirSync(dir, { recursive: true }); };

const AVATAR_EXTS = ['png', 'jpg', 'jpeg', 'webp'];

/** 找全身透明图（动作素材首选）。 */
async function findCharacter(id) {
  for (const ext of AVATAR_EXTS) {
    const candidate = join(petDir(), `${id}-character.${ext}`);
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

/** 找某只宠物已经落盘的头像文件（扩展名按真实文件，不猜）。 */
async function findAvatar(id) {
  for (const ext of AVATAR_EXTS) {
    const candidate = join(petDir(), `${id}-avatar.${ext}`);
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

/** 只认 PNG / JPEG / WebP 的真实文件头，不信调用方给的扩展名。 */
function imageExt(bytes) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 把一只宠物登记进 main-config.jsonc 的 pets[]（幂等；写前留 .bak）。 */
function registerInstance({ id, name }) {
  const path = mainConfigPath();
  if (!existsSync(path)) return { registered: false, reason: 'no-main-config' };
  let cfg;
  try { cfg = JSON.parse(readFileSync(path, 'utf8')); } catch { return { registered: false, reason: 'bad-json' }; }
  if (!Array.isArray(cfg.pets)) cfg.pets = [];
  if (cfg.pets.some((p) => p && p.id === id)) return { registered: false, reason: 'already-there' };
  cfg.pets.push({
    id,
    name,
    size: 380,
    balanceEnabled: false,
    whisperEnabled: true,
    workStatusEnabled: true,
    fixedEnabled: false,
    display: 'both',
    position: { corner: 'bottom-right', marginX: 24, marginY: 100 },
  });
  try { copyFileSync(path, path + '.bak'); } catch { /* 备份失败不阻塞主流程 */ }
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
  return { registered: true };
}

export function apply(ctx, config = {}) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/api/status`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, reason: 'method-not-allowed' });
      const dir = petDir();
      return json(res, 200, {
        ok: true,
        dshPetInstalled: existsSync(petRoot()),
        petDir: dir,
        generation: Boolean((config.imageBaseUrl || process.env.PET_STUDIO_IMAGE_BASE_URL) && (config.imageModel || process.env.PET_STUDIO_IMAGE_MODEL)),
        packs: existsSync(dir)
          ? (await import('node:fs')).readdirSync(dir).filter((n) => n.endsWith('-config.json')).map((n) => n.slice(0, -'-config.json'.length))
          : [],
      });
    },
  }), 'pet-studio: status');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/api/pack`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, reason: 'method-not-allowed' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, reason: 'bad-json' }); }

      const id = String(body.id ?? '').trim();
      const displayName = String(body.name ?? '').trim() || id;
      if (!ID_RE.test(id)) return json(res, 400, { ok: false, reason: 'bad-id', message: 'id 只能是小写字母/数字/连字符' });
      if (!existsSync(petRoot())) return json(res, 200, { ok: false, reason: 'dsh-pet-missing', message: '没检测到 dsh-pet，请先安装它' });

      const avatarRaw = typeof body.avatarBase64 === 'string' ? body.avatarBase64 : '';
      if (avatarRaw === '') return json(res, 400, { ok: false, reason: 'avatar-required' });
      let avatarBytes;
      try { avatarBytes = Buffer.from(avatarRaw, 'base64'); } catch { return json(res, 400, { ok: false, reason: 'bad-base64' }); }
      if (avatarBytes.length === 0 || avatarBytes.length > MAX_FILE) return json(res, 413, { ok: false, reason: 'avatar-too-large' });
      const ext = imageExt(avatarBytes);
      if (!ext) return json(res, 415, { ok: false, reason: 'unsupported-image' });

      const dir = petDir();
      ensureDir(dir);
      const avatarPath = join(dir, `${id}-avatar.${ext}`);
      writeFileSync(avatarPath, avatarBytes);

      let characterPath = null;
      const charRaw = typeof body.characterBase64 === 'string' ? body.characterBase64 : '';
      if (charRaw !== '') {
        try {
          const charBytes = Buffer.from(charRaw, 'base64');
          const charExt = imageExt(charBytes);
          if (charBytes.length > 0 && charBytes.length <= MAX_FILE * 3 && charExt) {
            characterPath = join(dir, `${id}-character.${charExt}`);
            writeFileSync(characterPath, charBytes);
          }
        } catch { /* 全身图可选：坏了就只用头像 */ }
      }

      // 人设与表情包：只在文件不存在时写，避免覆盖用户后来改的内容
      const configPath = join(dir, `${id}-config.json`);
      const persona = typeof body.persona === 'string' && body.persona.trim()
        ? body.persona.trim()
        : `你是主人桌面上的 Q 版宠物「${displayName}」。说人话，短句（20 字以内），语气自然、有点小情绪，不要提自己是 AI。`;
      const memes = body.memes && typeof body.memes === 'object' ? body.memes : {};
      if (!existsSync(configPath)) {
        writeFileSync(configPath, JSON.stringify({ whisperPrompt: persona, whisperImageEnabled: false, memes: {} }, null, 2) + '\n');
      }
      // 表情包（可选）
      const memeKeys = [];
      if (memes && Object.keys(memes).length > 0) {
        const memeDir = join(dir, `${id}-memes`);
        ensureDir(memeDir);
        for (const [key, b64] of Object.entries(memes)) {
          if (!/^[a-z0-9-]{1,24}$/.test(key) || typeof b64 !== 'string') continue;
          const bytes = Buffer.from(b64, 'base64');
          if (bytes.length === 0 || bytes.length > MAX_FILE) continue;
          const e = imageExt(bytes);
          if (!e) continue;
          writeFileSync(join(memeDir, `${key}.${e}`), bytes);
          memeKeys.push(key);
        }
      }

      const registration = body.register === false
        ? { registered: false, reason: 'skipped' }
        : registerInstance({ id, name: displayName });

      return json(res, 200, {
        ok: true,
        id,
        avatar: avatarPath,
        character: characterPath,
        memes: memeKeys,
        registration,
        note: registration.registered ? '已加入宠物列表，刷新页面即可看到' : '宠物包已写入，可在 dsh-pet 的「种类」里使用',
      });
    },
  }), 'pet-studio: pack');

  /**
   * POST /api/generate —— 用 OpenAI 兼容的 images/edits 把上传图转成 Q 版。
   *
   * 配置优先级：插件 config → 环境变量。没有配置时返回 generation-unavailable，
   * 前端据此隐藏按钮（不假装能用）。
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/api/generate`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, reason: 'method-not-allowed' });
      const baseUrl = String(config.imageBaseUrl ?? process.env.PET_STUDIO_IMAGE_BASE_URL ?? '').replace(/\/+$/, '');
      const model = String(config.imageModel ?? process.env.PET_STUDIO_IMAGE_MODEL ?? '');
      const apiKey = String(config.imageApiKey ?? process.env.PET_STUDIO_IMAGE_KEY ?? '');
      if (!baseUrl || !model) {
        return json(res, 200, { ok: false, reason: 'generation-unavailable', message: '没有配置图像模型：设置 imageBaseUrl / imageModel（或环境变量 PET_STUDIO_IMAGE_BASE_URL / PET_STUDIO_IMAGE_MODEL）' });
      }

      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, reason: 'bad-json' }); }
      const imageRaw = typeof body.imageBase64 === 'string' ? body.imageBase64 : '';
      if (!imageRaw) return json(res, 400, { ok: false, reason: 'image-required' });
      let bytes;
      try { bytes = Buffer.from(imageRaw, 'base64'); } catch { return json(res, 400, { ok: false, reason: 'bad-base64' }); }
      const ext = imageExt(bytes);
      if (!ext || bytes.length > MAX_FILE * 4) return json(res, 415, { ok: false, reason: 'unsupported-image' });

      const prompt = typeof body.prompt === 'string' && body.prompt.trim()
        ? body.prompt.trim()
        : '把这张照片里的主体画成可爱的 Q 版二次元角色立绘：大头小身子、圆润卡通比例、保留原本配色与特征、干净的浅色纯色背景、柔和描边、贴纸质感；不要写实照片风格。';

      const form = new FormData();
      form.set('model', model);
      form.set('prompt', prompt);
      form.set('n', '1');
      form.set('size', '1024x1024');
      form.set('image', new Blob([bytes], { type: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' }), 'input.' + ext);

      let payload;
      try {
        const upstream = await fetch(baseUrl + '/images/edits', {
          method: 'POST',
          headers: apiKey ? { authorization: 'Bearer ' + apiKey } : {},
          body: form,
          signal: AbortSignal.timeout(180_000),
        });
        const text = await upstream.text();
        try { payload = JSON.parse(text); } catch { return json(res, 502, { ok: false, reason: 'non-json', message: text.slice(0, 200) }); }
        if (!upstream.ok) return json(res, 502, { ok: false, reason: 'upstream-error', status: upstream.status, message: String(payload?.error?.message ?? payload?.message ?? '').slice(0, 300) });
      } catch (error) {
        return json(res, 502, { ok: false, reason: 'network', message: error?.message ?? String(error) });
      }

      const item = Array.isArray(payload?.data) ? payload.data[0] : undefined;
      let outBytes = null;
      try {
        if (item && typeof item.b64_json === 'string') outBytes = Buffer.from(item.b64_json, 'base64');
        else if (item && typeof item.url === 'string') {
          const dl = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
          if (dl.ok) outBytes = Buffer.from(await dl.arrayBuffer());
        }
      } catch { /* 落到下面的失败分支 */ }
      if (!outBytes || outBytes.length === 0) return json(res, 502, { ok: false, reason: 'no-image', message: '上游没有返回图片' });
      const outExt = imageExt(outBytes) ?? 'png';
      return json(res, 200, { ok: true, mime: 'image/' + outExt, imageBase64: outBytes.toString('base64') });
    },
  }), 'pet-studio: generate');

  // 生成整套动作素材（七段 webm），并把这些动作写进宠物包的 animations 配置。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/api/animate`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, reason: 'method-not-allowed' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, reason: 'bad-json' }); }
      const id = String(body.id ?? '').trim();
      if (!ID_RE.test(id)) return json(res, 400, { ok: false, reason: 'bad-id' });

      const character = await findCharacter(id);
      const avatar = await findAvatar(id);
      const source = character ?? avatar;
      if (!source) return json(res, 404, { ok: false, reason: 'avatar-missing', message: '先生成宠物包（头像）再生成动作' });

      let sharp;
      try { sharp = (await import('sharp')).default; } catch {
        return json(res, 200, { ok: false, reason: 'sharp-missing', message: '没有可用的 sharp，无法逐帧渲染' });
      }
      const ffmpeg = resolveFfmpeg(body);
      if (!(await ffmpegUsable(ffmpeg.path))) {
        return json(res, 200, { ok: false, reason: 'ffmpeg-missing', message: '没找到可用的 ffmpeg；可设置 FFMPEG_PATH 或装 @ffmpeg-installer/ffmpeg' });
      }

      const outDir = join(petDir(), `${id}-animation`);
      let result;
      try {
        result = await buildAnimations({ sharp, ffmpegPath: ffmpeg.path, srcPng: source, outDir });
      } catch (error) {
        return json(res, 500, { ok: false, reason: 'animate-failed', message: error?.message ?? String(error) });
      }

      const configPath = join(petDir(), `${id}-config.json`);
      let cfg = {};
      try { cfg = JSON.parse(readFileSync(configPath, 'utf8')); } catch { /* 没配置就新建 */ }
      Object.assign(cfg, animationConfig());
      writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');

      return json(res, 200, {
        ok: true,
        clips: result.clips,
        dir: result.dir,
        ffmpeg: ffmpeg.source,
        note: '动作已生成：内置动作被替换成这七段，睡觉/碎碎念/工作状态也接上了',
      });
    },
  }), 'pet-studio: animate');
}
