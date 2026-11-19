#!/usr/bin/env node
/**
 * 冒烟测试：对着**正在运行的** dsh web 校验插件契约。
 *
 *   node test/smoke.mjs            # 状态 + 建包 + 清理
 *   node test/smoke.mjs --animate  # 额外跑一次完整动作生成（约 2–4 分钟）
 *
 * 前置：dsh web 在跑，且已装 dsh-pet 与本插件。
 */
import { stat, rm, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.PET_STUDIO_BASE ?? 'http://127.0.0.1:3080/plugins/dsh-pet-studio/api';
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const PET_DIR = join(HOME, 'dsh-pet', 'pet');
const ID = 'smoketest';
const wantAnimate = process.argv.includes('--animate');

const fail = (message) => { console.error('✗', message); process.exit(1); };
const ok = (message) => console.log('✓', message);

const post = async (path, body) => {
  const response = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

// 1. status
const status = await (await fetch(BASE + '/status')).json();
if (!status.ok) fail('status 不可用：' + JSON.stringify(status));
if (!status.dshPetInstalled) fail('没检测到 dsh-pet');
ok(`status ok｜宠物目录 ${status.petDir}｜已有包 ${JSON.stringify(status.packs)}｜生成能力 ${status.generation}`);

// 2. 建包（用工作区里现成的 512 图）
const avatar = await readFile(new URL('./fixtures/avatar.png', import.meta.url));
const created = await post('/pack', { id: ID, name: '冒烟测试', avatarBase64: avatar.toString('base64'), register: false });
if (!created.body.ok) fail('建包失败：' + JSON.stringify(created.body));
const avatarPath = join(PET_DIR, `${ID}-avatar.png`);
await stat(avatarPath);
ok('建包 ok｜' + created.body.avatar);

// 3. 动作（可选）
if (wantAnimate) {
  const started = Date.now();
  const anim = await post('/animate', { id: ID });
  if (!anim.body.ok) fail('动作生成失败：' + JSON.stringify(anim.body));
  for (const clip of anim.body.clips) await stat(join(PET_DIR, `${ID}-animation`, `${clip}.webm`));
  ok(`动作 ok｜${anim.body.clips.join('/')}｜耗时 ${Math.round((Date.now() - started) / 1000)}s`);
}

// 4. 清理
await rm(avatarPath, { force: true });
await rm(join(PET_DIR, `${ID}-config.json`), { force: true });
await rm(join(PET_DIR, `${ID}-animation`), { recursive: true, force: true });
ok('清理完成');
