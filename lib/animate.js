/**
 * 程序化动作生成：把一张透明角色图渲染成一整套 webm 循环。
 *
 * 这样自定义宠物不必依赖内置角色的动画资产：idle / walk / turn / drag / click /
 * sleep / whisper 七段全部由这张图生成，dsh-pet 的整套动作与事件（余额、碎碎念、
 * 工作状态、睡觉）都能对上。
 *
 * 依赖：sharp（逐帧变换）+ ffmpeg（VP9 + alpha 编码）。两者都缺失时由调用方
 * 降级为「复用内置动画」，不阻塞宠物包创建。
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const CANVAS = 760;
const CHAR_H = 640;

/** 找到可用的 ffmpeg：显式配置 → 环境变量 → @ffmpeg-installer/ffmpeg → PATH 里的 ffmpeg。 */
export function resolveFfmpeg(config = {}) {
  const candidates = [
    config.ffmpegPath,
    process.env.DSH_PET_STUDIO_FFMPEG,
    process.env.FFMPEG_PATH,
  ].filter((v) => typeof v === 'string' && v.trim() !== '');
  for (const candidate of candidates) return { path: candidate, source: 'configured' };
  try {
    const installed = require('@ffmpeg-installer/ffmpeg');
    if (installed && typeof installed.path === 'string') return { path: installed.path, source: 'ffmpeg-installer' };
  } catch { /* 没装就继续 */ }
  return { path: 'ffmpeg', source: 'path' };
}

const run = (cmd, args, timeoutMs = 180_000) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ffmpeg timeout')); }, timeoutMs);
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
  child.on('error', (error) => { clearTimeout(timer); reject(error); });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0) resolve();
    else reject(new Error(`ffmpeg exit ${code}: ${stderr.split('\n').filter(Boolean).slice(-2).join(' | ')}`));
  });
});

/** 七段动作的时间函数：t ∈ [0,1)，返回该帧的变换参数。 */
const CLIPS = [
  {
    name: 'idle', frames: 30, fps: 18,
    at: (t) => ({ scale: 1 + 0.022 * Math.sin(2 * Math.PI * t), rotate: 0, dx: 0, dy: 5 * Math.sin(2 * Math.PI * t) }),
  },
  {
    name: 'walk', frames: 24, fps: 18,
    at: (t) => ({
      scale: 1,
      rotate: 2.5 * Math.sin(2 * Math.PI * t),
      dx: 10 * Math.sin(2 * Math.PI * t),
      dy: -6 * Math.abs(Math.sin(2 * Math.PI * t)),
    }),
  },
  {
    name: 'turn', frames: 18, fps: 18,
    at: (t) => ({ scale: 1, rotate: 3 * Math.sin(2 * Math.PI * t), dx: 6 * Math.sin(2 * Math.PI * t), dy: 0 }),
  },
  {
    name: 'drag', frames: 18, fps: 18,
    at: (t) => ({ scale: 0.99, rotate: -5 * Math.sin(2 * Math.PI * t), dx: 0, dy: -4 + 3 * Math.sin(2 * Math.PI * t) }),
  },
  {
    name: 'click', frames: 15, fps: 18,
    at: (t) => ({
      scale: 1 + 0.06 * Math.sin(2 * Math.PI * t) * Math.exp(-2.2 * t),
      rotate: 0, dx: 0, dy: -10 * Math.sin(Math.PI * t) * Math.exp(-2 * t),
    }),
  },
  {
    name: 'sleep', frames: 24, fps: 12,
    at: (t) => ({ scale: 0.955 + 0.006 * Math.sin(2 * Math.PI * t), rotate: 4, dx: 0, dy: 14 }),
  },
  {
    name: 'whisper', frames: 18, fps: 18,
    at: (t) => ({ scale: 1, rotate: -1.2, dx: 0, dy: 4 * Math.sin(2 * Math.PI * t) }),
  },
];

async function renderFrames(sharp, srcPng, clip, dir) {
  const meta = await sharp(srcPng).metadata();
  const baseW = Math.round((meta.width / meta.height) * CHAR_H);
  for (let i = 0; i < clip.frames; i += 1) {
    const t = i / clip.frames;
    const { scale, rotate, dx, dy } = clip.at(t);
    const w = Math.max(8, Math.round(baseW * scale));
    const h = Math.max(8, Math.round(CHAR_H * scale));

    // 旋转后的外接尺寸（解析计算，省掉一次 metadata 往返）
    const rad = (Math.abs(rotate) * Math.PI) / 180;
    const rw = Math.round(w * Math.cos(rad) + h * Math.sin(rad));
    const rh = Math.round(w * Math.sin(rad) + h * Math.cos(rad));

    let left = Math.round((CANVAS - rw) / 2 + dx);
    let top = Math.round((CANVAS - rh) / 2 + dy);
    left = Math.max(0, Math.min(CANVAS - 1, left));
    top = Math.max(0, Math.min(CANVAS - 1, top));

    let pipeline = sharp(srcPng).resize(w, h, { fit: 'fill' });
    if (Math.abs(rotate) >= 0.05) {
      pipeline = pipeline.rotate(rotate, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
    }
    // 一次 pipeline 直接扩到固定画布：不再「编码 PNG → 再解码合成」两次往返
    pipeline = pipeline.extend({
      top,
      left,
      bottom: Math.max(0, CANVAS - top - rh),
      right: Math.max(0, CANVAS - left - rw),
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
    await pipeline.png({ compressionLevel: 1 }).toFile(join(dir, `f${String(i).padStart(3, '0')}.png`));
  }
}

/**
 * 生成整套动作素材。
 *
 * @param {{ sharp: any, ffmpegPath: string, srcPng: string|Buffer, outDir: string, onProgress?: (msg: string) => void }} options
 * @returns {Promise<{ clips: string[], dir: string }>}
 */
export async function buildAnimations({ sharp, ffmpegPath, srcPng, outDir, onProgress }) {
  await mkdir(outDir, { recursive: true });
  const tmp = join(outDir, '.frames');
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });

  const produced = [];
  for (const [index, clip] of CLIPS.entries()) {
    if (onProgress) onProgress(`渲染 ${clip.name}（${index + 1}/${CLIPS.length}）`);
    const frameDir = join(tmp, clip.name);
    await mkdir(frameDir, { recursive: true });
    await renderFrames(sharp, srcPng, clip, frameDir);
    const out = join(outDir, `${clip.name}.webm`);
    await run(ffmpegPath, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-framerate', String(clip.fps),
      '-i', join(frameDir, 'f%03d.png'),
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
      '-auto-alt-ref', '0', '-b:v', '0', '-crf', '34',
      '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-an',
      out,
    ]);
    produced.push(clip.name);
  }
  await rm(tmp, { recursive: true, force: true });
  return { clips: produced, dir: outDir };
}

/** dsh-pet 的动画配置块：所有状态都指向我们生成的这七段。 */
export function animationConfig() {
  const idle = ['idle'];
  return {
    animations: {
      idle,
      turn: ['turn'],
      drag: ['drag'],
      clicks: ['click'],
      moves: {
        default: { minDist: 60, maxDist: 240, margin: 20, leadSec: 2, tailSec: 2 },
        actions: [{ name: 'walk' }],
      },
      categories: [{ id: '小动作', weight: 80, actions: ['idle', 'walk', 'click'] }],
      events: {
        balance: ['idle', 'idle', 'idle', 'idle', 'idle', 'idle'],
        whisper: ['whisper'],
        workStatus: ['whisper', 'walk', 'walk', 'walk', 'click', 'sleep'],
      },
      // sleep 是 animations 的顶层键，不是 events 里的键（放错会让整个 animations 被判非法）
      sleep: [{ start: ['sleep'], loop: ['sleep'], end: ['sleep'] }],
    },
    animationWeights: { idle: 10, turn: 5, move: 5 },
  };
}

/** ffmpeg 是否真的可用（跑一次 -version）。 */
export async function ffmpegUsable(ffmpegPath) {
  try { await run(ffmpegPath, ['-version'], 15_000); return true; } catch { return false; }
}

export async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}
