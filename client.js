/**
 * dsh-pet-studio —— 客户端设置页「宠物工坊」。
 *
 * 流程：选一张图 → 浏览器里抠图（从四边泛洪填充去背景）→ 居中裁成 512 方图 →
 * 交给宿主写进 dsh-pet 的宠物包目录。不依赖任何图像服务，也不上传到第三方。
 */
window.__ModuleLoader__.load({
  id: 'dsh-pet-studio',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useCallback, useEffect } = React;

    const BASE = '/plugins/dsh-pet-studio/api';

    const box = {
      display: 'flex', flexDirection: 'column', gap: 12, padding: 4, maxWidth: 720,
    };
    const row = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' };
    const label = { fontSize: 13, opacity: 0.75, minWidth: 68 };
    const input = {
      flex: 1, minWidth: 180, padding: '7px 10px', borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit', fontSize: 13,
    };
    const button = (busy) => ({
      padding: '7px 14px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)',
      background: busy ? 'transparent' : 'var(--dsw-alias-fill-secondary, rgba(120,120,120,.12))',
      color: 'inherit', fontSize: 13, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1,
    });

    /** 从四边泛洪填充，把与边角同色的背景变透明；再裁到内容外接框、缩成 512 方图。 */
    async function cutout(file) {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const hgt = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = hgt;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      g.drawImage(bitmap, 0, 0, w, hgt);
      const imageData = g.getImageData(0, 0, w, hgt);
      const d = imageData.data;

      const at = (x, y) => (y * w + x) * 4;
      const corners = [at(0, 0), at(w - 1, 0), at(0, hgt - 1), at(w - 1, hgt - 1)];
      const bg = [0, 1, 2].map((k) => corners.reduce((s, i) => s + d[i + k], 0) / corners.length);
      const tol = 22 * 22 * 3;
      const isBg = (i) => {
        const dr = d[i] - bg[0], dg = d[i + 1] - bg[1], db = d[i + 2] - bg[2];
        return dr * dr + dg * dg + db * db < tol;
      };

      const seen = new Uint8Array(w * hgt);
      const stack = new Int32Array(w * hgt);
      let sp = 0;
      const push = (x, y) => {
        const p = y * w + x;
        if (seen[p] || !isBg(p * 4)) return;
        seen[p] = 1; stack[sp++] = p;
      };
      for (let x = 0; x < w; x += 1) { push(x, 0); push(x, hgt - 1); }
      for (let y = 0; y < hgt; y += 1) { push(0, y); push(w - 1, y); }
      while (sp > 0) {
        const p = stack[--sp];
        const x = p % w, y = (p - x) / w;
        if (x > 0) push(x - 1, y);
        if (x < w - 1) push(x + 1, y);
        if (y > 0) push(x, y - 1);
        if (y < hgt - 1) push(x, y + 1);
      }

      let minX = w, minY = hgt, maxX = -1, maxY = -1;
      for (let y = 0; y < hgt; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const p = y * w + x;
          if (seen[p]) { d[p * 4 + 3] = 0; continue; }
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      if (maxX < minX || maxY < minY) throw new Error('没找到主体：请用背景干净、主体完整的图');

      g.putImageData(imageData, 0, 0);
      const cw = maxX - minX + 1;
      const ch = maxY - minY + 1;

      // 全身透明图：不裁方，保留比例，长边 <= 1024（动作素材用这张）
      const kc = Math.min(1, 1024 / Math.max(cw, ch));
      const charCanvas = document.createElement('canvas');
      charCanvas.width = Math.max(1, Math.round(cw * kc));
      charCanvas.height = Math.max(1, Math.round(ch * kc));
      charCanvas.getContext('2d').drawImage(canvas, minX, minY, cw, ch, 0, 0, charCanvas.width, charCanvas.height);
      const character = charCanvas.toDataURL('image/png');

      // 头像：主体居中缩成 512 方图（聊天里的那张小图）
      const out = document.createElement('canvas');
      out.width = 512; out.height = 512;
      const og = out.getContext('2d');
      const side = Math.min(512, Math.max(cw, ch));
      const k = side / Math.max(cw, ch);
      const dw = cw * k, dh = ch * k;
      og.drawImage(canvas, minX, minY, cw, ch, (512 - dw) / 2, (512 - dh) / 2, dw, dh);
      return { avatar: out.toDataURL('image/png'), character };
    }

    function PetStudio() {
      const [file, setFile] = useState(null);
      const [preview, setPreview] = useState('');
      const [character, setCharacter] = useState('');
      const [prompt, setPrompt] = useState('');
      const [canGenerate, setCanGenerate] = useState(false);
      const [id, setId] = useState('mypet');
      const [displayName, setDisplayName] = useState('我的宠物');
      const [persona, setPersona] = useState('');
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState('');

      useEffect(() => {
        fetch(BASE + '/status')
          .then((r) => r.json())
          .then((b) => setCanGenerate(Boolean(b && b.generation)))
          .catch(() => setCanGenerate(false));
      }, []);

      const onGenerate = useCallback(async () => {
        if (!file) { setMessage('先选一张照片'); return; }
        setBusy(true);
        setMessage('正在调用图像模型生成 Q 版（可能 10–60 秒）…');
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('读取图片失败'));
            reader.readAsDataURL(file);
          });
          const response = await fetch(BASE + '/generate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ imageBase64: dataUrl.split(',')[1] || '', prompt: prompt.trim() }),
          });
          const body = await response.json();
          if (!body.ok) throw new Error(body.message || body.reason || ('HTTP ' + response.status));
          const bytes = Uint8Array.from(atob(body.imageBase64), (c) => c.charCodeAt(0));
          const blob = new Blob([bytes], { type: body.mime || 'image/png' });
          const result = await cutout(new File([blob], 'generated.png', { type: blob.type }));
          setPreview(result.avatar);
          setCharacter(result.character);
          setMessage('Q 版已生成并抠好图，确认满意后点「生成宠物包」');
        } catch (error) {
          setMessage('生成失败：' + (error && error.message ? error.message : String(error)));
        } finally {
          setBusy(false);
        }
      }, [file, prompt]);

      const onPick = useCallback(async (event) => {
        const picked = event.target.files && event.target.files[0];
        if (!picked) return;
        setFile(picked);
        setMessage('正在抠图…');
        setBusy(true);
        try {
          const result = await cutout(picked);
          setPreview(result.avatar);
          setCharacter(result.character);
          setMessage('抠图完成，可以生成宠物包了');
        } catch (error) {
          setPreview('');
          setMessage('抠图失败：' + (error && error.message ? error.message : String(error)));
        } finally {
          setBusy(false);
        }
      }, []);

      const submit = useCallback(async () => {
        if (!preview) { setMessage('先选一张图片'); return; }
        setBusy(true);
        setMessage('正在写入宠物包…');
        try {
          const response = await fetch(BASE + '/pack', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: id.trim().toLowerCase(),
              name: displayName.trim() || id.trim(),
              persona: persona.trim(),
              avatarBase64: preview.split(',')[1] || '',
              characterBase64: character.split(',')[1] || '',
              register: true,
            }),
          });
          const body = await response.json();
          if (!body.ok) throw new Error(body.message || body.reason || ('HTTP ' + response.status));
          setMessage('宠物包已写入，正在生成动作（约 1–2 分钟）…');
          const animResponse = await fetch(BASE + '/animate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: id.trim().toLowerCase() }),
          });
          const anim = await animResponse.json();
          if (!anim.ok) {
            setMessage('宠物包已写入（' + (body.note || '') + '），但动作没生成：' + (anim.message || anim.reason));
            return;
          }
          setMessage('全部完成：头像 + ' + anim.clips.length + ' 段动作已生成（' + anim.clips.join(' / ') + '）。刷新页面后在「设置 → 桌宠配置 → 种类」里选它。');
        } catch (error) {
          setMessage('写入失败：' + (error && error.message ? error.message : String(error)));
        } finally {
          setBusy(false);
        }
      }, [preview, id, displayName, persona]);

      return h('div', { style: box },
        h('div', { style: { fontSize: 15, fontWeight: 600 } }, '宠物工坊'),
        h('div', { style: { fontSize: 12, opacity: 0.7, lineHeight: 1.6 } },
          '选一张画好的 Q 版角色图（或照片）。会在本地把背景抠掉、裁成 512 头像，写进 dsh-pet 的宠物包；内置宠物不受影响。'),
        h('div', { style: row }, h('span', { style: label }, '宠物图'), h('input', { type: 'file', accept: 'image/*', onChange: onPick, style: { fontSize: 12 } })),
        h('div', { style: row }, h('span', { style: label }, 'ID'), h('input', { style: input, value: id, onChange: (e) => setId(e.target.value), placeholder: '小写字母/数字/连字符' })),
        h('div', { style: row }, h('span', { style: label }, '名字'), h('input', { style: input, value: displayName, onChange: (e) => setDisplayName(e.target.value) })),
        h('div', { style: row }, h('span', { style: label }, '人设'), h('input', { style: input, value: persona, onChange: (e) => setPersona(e.target.value), placeholder: '留空用默认：说人话、短句、不说自己是 AI' })),
        canGenerate ? h('div', { style: row },
          h('span', { style: label }, '风格'),
          h('input', { style: input, value: prompt, onChange: (e) => setPrompt(e.target.value), placeholder: '留空用默认 Q 版提示词' })) : null,
        canGenerate ? h('div', { style: row },
          h('button', { type: 'button', style: button(busy), disabled: busy || !file, onClick: onGenerate }, busy ? '处理中…' : 'AI 生成 Q 版')) : null,
        preview ? h('img', { src: preview, width: 160, height: 160, style: { borderRadius: 12, border: '1px solid var(--dsw-alias-border-l2)' } }) : null,
        h('div', { style: row },
          h('button', { type: 'button', style: button(busy), disabled: busy || !preview, onClick: submit }, busy ? '处理中…' : '生成宠物包')),
        message ? h('div', { style: { fontSize: 12, opacity: 0.85, lineHeight: 1.6 } }, message) : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'pet-studio',
          order: 70,
          label: '宠物工坊',
        }, PetStudio));
      },
    };
  },
});
