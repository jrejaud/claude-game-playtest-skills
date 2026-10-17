#!/usr/bin/env node
// web-playtest — drive any web page with real input: mouse, keyboard, touch (multi-touch),
// device emulation. A background server holds one Chromium page per session so input state
// (held keys, pressed buttons, open menus) persists across CLI calls.
//
//   web-playtest start <url> [--device desktop|iphone|ipad|pixel|"<Playwright device>"] [--headed] [--video DIR]
//   web-playtest <verb> [args] [--session NAME]
//   web-playtest stop
//
// Touch goes through CDP Input.dispatchTouchEvent (Chromium only): it enters the real input
// pipeline, so pages receive TouchEvent AND PointerEvent (pointerType "touch") exactly as from
// a finger. Playwright's own touchscreen API only does single taps.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const STATE_DIR = path.join(os.homedir(), '.cache', 'web-playtest');
const SHOT_DIR = process.env.WEB_PLAYTEST_SHOTS || path.join(STATE_DIR, 'shots');
// Optional explicit Chromium binary to try if the Playwright-managed one is missing.
const CHROMIUM_FALLBACK = process.env.WEB_PLAYTEST_CHROMIUM || null;
const DEVICE_ALIASES = { iphone: 'iPhone 15 Pro', ipad: 'iPad Pro 11', pixel: 'Pixel 7', android: 'Pixel 7' };

// ---------- arg parsing ----------
function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      if (inline !== undefined) opts[k] = inline;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[k] = argv[++i];
      else opts[k] = true;
    } else pos.push(a);
  }
  return { pos, opts };
}

// Split one script line like a shell would (quotes, no expansion).
function splitLine(line) {
  const out = [];
  let cur = '';
  let q = null;
  let has = false;
  for (const ch of line) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

const statePath = (s) => path.join(STATE_DIR, `${s}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- client ----------
async function send(session, cmd, pos, opts) {
  const sp = statePath(session);
  if (!fs.existsSync(sp)) throw new Error(`no session "${session}" — run: web-playtest start <url>`);
  const { port } = JSON.parse(fs.readFileSync(sp, 'utf8'));
  const body = JSON.stringify({ cmd, pos, opts });
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/run', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            reject(new Error(buf));
          }
        });
      },
    );
    req.on('error', (e) => reject(new Error(`session "${session}" not reachable (${e.code}) — stale? run: web-playtest stop && start`)));
    req.end(body);
  });
}

async function start(session, pos, opts) {
  const url = pos[0];
  if (!url) throw new Error('usage: web-playtest start <url> [--device D] [--headed] [--video DIR]');
  const sp = statePath(session);
  if (fs.existsSync(sp)) {
    try {
      await send(session, 'ping', [], {});
      if (!opts.replace) throw new Error(`session "${session}" already running — use --replace or --session NAME`);
      await send(session, 'stop', [], {}).catch(() => {});
      await sleep(300);
    } catch (e) {
      if (String(e.message).includes('already running')) throw e;
    }
    fs.rmSync(sp, { force: true });
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const log = path.join(STATE_DIR, `${session}.log`);
  const fd = fs.openSync(log, 'w');
  const args = [SELF, '_serve', url, '--session', session];
  for (const k of ['device', 'video']) if (opts[k]) args.push(`--${k}`, String(opts[k]));
  if (opts.headed) args.push('--headed');
  if (opts.gpu) args.push('--gpu');
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  // 60 s: a cold launch of the real Chrome (WEB_PLAYTEST_EXECUTABLE) measured >15 s on macOS
  // (macOS first-launch checks); warm launches take ~2 s.
  for (let i = 0; i < 600; i++) {
    await sleep(100);
    if (fs.existsSync(sp)) return JSON.parse(fs.readFileSync(sp, 'utf8'));
    if (child.exitCode !== null) break;
  }
  throw new Error(`server failed to start — see ${log}:\n${fs.readFileSync(log, 'utf8').slice(-1500)}`);
}

// ---------- server ----------
async function serve(url, opts) {
  const { chromium, devices } = await import('playwright-core');
  const session = opts.session;
  let device = String(opts.device || 'desktop');
  let ctxOpts;
  if (device === 'desktop') ctxOpts = { viewport: { width: 1440, height: 900 } };
  else {
    const name = DEVICE_ALIASES[device.toLowerCase()] || Object.keys(devices).find((d) => d.toLowerCase() === device.toLowerCase());
    if (!name) throw new Error(`unknown device "${device}". Aliases: desktop, ${Object.keys(DEVICE_ALIASES).join(', ')}; or any Playwright device name`);
    const { defaultBrowserType: _ignored, ...d } = devices[name];
    ctxOpts = d;
    device = name;
  }
  if (opts.video) ctxOpts.recordVideo = { dir: path.resolve(String(opts.video)), size: ctxOpts.viewport };
  // --gpu: render on the real GPU (Metal via ANGLE). Headless Chromium otherwise
  // falls back to SwiftShader, where a WebGL frame costs ~600 ms and frame-time
  // numbers say nothing about a device.
  // WEB_PLAYTEST_ARGS: extra Chromium flags for this session, space-separated (e.g.
  // --disable-features=WebRtcHideLocalIpsWithMdns so two headless sessions on one
  // machine can open a WebRTC connection to each other).
  const extra = (process.env.WEB_PLAYTEST_ARGS ?? '').split(/\s+/).filter(Boolean);
  const gpuArgs = opts.gpu ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] : [];
  // WEB_PLAYTEST_EXECUTABLE: a different Chromium-family binary (e.g. an installed
  // Google Chrome the macOS firewall already lets accept connections — WebRTC between
  // sessions needs that). Always a fresh temporary profile, never a personal one.
  const exe = process.env.WEB_PLAYTEST_EXECUTABLE;
  const launch = {
    headless: !opts.headed,
    ...(exe ? { executablePath: exe } : {}),
    ...(gpuArgs.length || extra.length ? { args: [...gpuArgs, ...extra] } : {}),
  };
  try {
    var browser = await chromium.launch(launch);
  } catch (e) {
    if (!CHROMIUM_FALLBACK) throw new Error(`${e.message}\nNo Chromium found: run the skill's scripts/web-playtest once (it installs one), or set WEB_PLAYTEST_EXECUTABLE.`);
    browser = await chromium.launch({ ...launch, executablePath: CHROMIUM_FALLBACK });
  }
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const consoleBuf = [];
  page.on('console', (m) => consoleBuf.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => consoleBuf.push(`[pageerror] ${e.message}`));
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  const mouse = { x: 0, y: 0 };
  const touchOn = { enabled: !!ctxOpts.hasTouch };

  async function point(spec, o = {}) {
    if (spec === undefined) throw new Error('missing target: "x,y" or a selector');
    let p;
    const m = String(spec).match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
    if (m) p = { x: +m[1], y: +m[2] };
    else if (String(spec).startsWith('@')) {
      // Canvas/WebGL apps have no DOM per object: "@<js expr>" evaluates in the page and must
      // return {x,y} or [x,y] in viewport pixels, e.g. '@__app.screenPos("card-7")'.
      const v = await page.evaluate(String(spec).slice(1));
      const [x, y] = Array.isArray(v) ? v : [v?.x, v?.y];
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`target expr did not return {x,y}: ${spec}`);
      p = { x, y };
    } else {
      const box = await page.locator(String(spec)).first().boundingBox({ timeout: 2500 });
      if (!box) throw new Error(`target not visible: ${spec}`);
      p = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    if (o.offset) {
      const [dx, dy] = String(o.offset).split(',').map(Number);
      p = { x: p.x + dx, y: p.y + dy };
    }
    return p;
  }
  const mods = (o) => (o.mods ? String(o.mods).split(/[+,]/).filter(Boolean) : []);
  async function withMods(o, fn) {
    const ms = mods(o);
    for (const k of ms) await page.keyboard.down(k);
    try {
      return await fn();
    } finally {
      for (const k of ms.reverse()) await page.keyboard.up(k);
    }
  }
  async function moveTo(p, steps = 1) {
    await page.mouse.move(p.x, p.y, { steps });
    Object.assign(mouse, p);
  }
  async function ensureTouch() {
    if (touchOn.enabled) return;
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    touchOn.enabled = true;
  }
  const touch = (type, pts) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i, radiusX: 4, radiusY: 4, force: 1 })) });
  // Interpolate N fingers from `from[]` to `to[]` over `ms`, ~60 Hz.
  async function touchPath(from, to, ms) {
    const steps = Math.max(2, Math.round(ms / 16));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      await touch('touchMove', from.map((f, i) => ({ x: f.x + (to[i].x - f.x) * t, y: f.y + (to[i].y - f.y) * t })));
      await sleep(ms / steps);
    }
  }
  const num = (v, d) => (v === undefined || v === true ? d : Number(v));

  const verbs = {
    ping: async () => ({ ok: true }),
    info: async () => ({ url: page.url(), title: await page.title(), device, viewport: page.viewportSize(), touch: touchOn.enabled, mouse }),
    goto: async ([u]) => (await page.goto(u, { waitUntil: 'load' }), { url: page.url() }),
    reload: async () => (await page.reload({ waitUntil: 'load' }), { url: page.url() }),
    resize: async ([w, h]) => (await page.setViewportSize({ width: +w, height: +h }), { viewport: page.viewportSize() }),
    // CPU slowdown via CDP: 4 = a mid-range phone in DevTools terms, 1 = off.
    throttle: async ([rate]) => (await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(rate ?? 1) }), { cpuThrottle: Number(rate ?? 1) }),
    wait: async ([ms]) => (await sleep(num(ms, 500)), {}),
    // ---- observe ----
    screenshot: async ([p], o) => {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const file = p ? path.resolve(p) : path.join(SHOT_DIR, `${session}-${Date.now()}.png`);
      const target = o.sel ? page.locator(String(o.sel)).first() : page;
      await target.screenshot({ path: file, fullPage: !!o.full && !o.sel });
      return { path: file };
    },
    snapshot: async ([sel]) => ({ aria: await page.locator(sel || 'body').first().ariaSnapshot({ timeout: 5000 }) }),
    eval: async ([expr]) => ({ value: await page.evaluate(expr) }),
    rect: async ([sel]) => {
      const loc = page.locator(sel);
      const n = await loc.count();
      const rects = [];
      for (let i = 0; i < Math.min(n, 50); i++) rects.push(await loc.nth(i).boundingBox());
      return { count: n, rects };
    },
    console: async (_, o) => {
      const lines = consoleBuf.slice();
      if (o.clear) consoleBuf.length = 0;
      return { lines };
    },
    // Record the DOM input events the page actually received — proves a gesture registered.
    events: async ([action = 'dump']) => {
      if (action === 'on') {
        await page.evaluate(() => {
          if (window.__wptRec) return;
          window.__wptEvents = [];
          const types = ['pointerdown', 'pointerup', 'pointercancel', 'click', 'dblclick', 'contextmenu', 'touchstart', 'touchend', 'touchcancel', 'keydown', 'keyup', 'wheel', 'dragstart', 'drop'];
          const desc = (el) => (el && el.tagName ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.dataset && Object.keys(el.dataset).length ? '[' + Object.entries(el.dataset).slice(0, 2).map(([k, v]) => `${k}=${v}`).join(',') + ']' : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '') : String(el));
          window.__wptRec = (e) => window.__wptEvents.push({ t: Math.round(e.timeStamp), type: e.type, target: desc(e.target), ...(e.pointerType ? { pointerType: e.pointerType } : {}), ...(e.key ? { key: e.key } : {}), ...('clientX' in e ? { x: Math.round(e.clientX), y: Math.round(e.clientY) } : {}), ...(e.touches ? { touches: e.touches.length } : {}), ...(e.shiftKey || e.altKey || e.ctrlKey || e.metaKey ? { mods: ['shift', 'alt', 'ctrl', 'meta'].filter((m) => e[m + 'Key']).join('+') } : {}), prevented: e.defaultPrevented });
          for (const t of types) window.addEventListener(t, window.__wptRec, { capture: true, passive: true });
        });
        return { recording: true };
      }
      const evts = await page.evaluate(() => window.__wptEvents || null);
      if (evts === null) return { error: 'recorder off — run: web-playtest events on' };
      if (action === 'clear') await page.evaluate(() => (window.__wptEvents = []));
      return { events: evts };
    },
    // Visible cursor/finger dots so screenshots and videos show where input landed.
    cursor: async ([action = 'on']) => {
      await page.evaluate((on) => {
        document.getElementById('__wpt_cursor_style')?.remove();
        window.__wptCursorOff?.();
        if (!on) return;
        const st = document.createElement('style');
        st.id = '__wpt_cursor_style';
        st.textContent = '.__wpt_dot{position:fixed;z-index:2147483647;pointer-events:none;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;border:2px solid #fff;background:rgba(255,0,80,.6);box-shadow:0 0 4px #000;transition:transform .08s}.__wpt_dot.down{transform:scale(.65);background:rgba(255,200,0,.85)}';
        document.head.appendChild(st);
        const dots = new Map();
        const get = (id) => {
          if (!dots.has(id)) {
            const d = document.createElement('div');
            d.className = '__wpt_dot';
            document.body.appendChild(d);
            dots.set(id, d);
          }
          return dots.get(id);
        };
        const h = (e) => {
          const d = get(e.pointerId);
          d.style.left = e.clientX + 'px';
          d.style.top = e.clientY + 'px';
          d.classList.toggle('down', e.buttons > 0 || e.type === 'pointerdown');
          if (e.pointerType === 'touch' && (e.type === 'pointerup' || e.type === 'pointercancel')) setTimeout(() => (d.remove(), dots.delete(e.pointerId)), 250);
        };
        const ts = ['pointermove', 'pointerdown', 'pointerup', 'pointercancel'];
        ts.forEach((t) => window.addEventListener(t, h, { capture: true, passive: true }));
        window.__wptCursorOff = () => (ts.forEach((t) => window.removeEventListener(t, h, { capture: true })), dots.forEach((d) => d.remove()));
      }, action !== 'off');
      return { cursor: action !== 'off' };
    },
    // ---- mouse ----
    move: async ([t], o) => (await moveTo(await point(t, o), num(o.steps, 10)), { mouse }),
    down: async (_, o) => (await page.mouse.down({ button: o.button || 'left' }), { mouse }),
    up: async (_, o) => (await page.mouse.up({ button: o.button || 'left' }), { mouse }),
    click: async ([t], o) => {
      const p = await point(t, o);
      await withMods(o, async () => {
        await moveTo(p, num(o.steps, 5));
        await page.mouse.click(p.x, p.y, { button: o.button || 'left', clickCount: num(o.count, 1), delay: num(o.delay, 30) });
      });
      return { at: p };
    },
    dblclick: async ([t], o) => verbs.click([t], { ...o, count: 2 }),
    rclick: async ([t], o) => verbs.click([t], { ...o, button: 'right' }),
    hover: async ([t], o) => {
      const p = await point(t, o);
      await moveTo(p, num(o.steps, 10));
      if (o.ms) await sleep(num(o.ms, 0));
      return { at: p };
    },
    wheel: async ([dx, dy], o) => {
      if (o.at) await moveTo(await point(o.at), 5);
      await withMods(o, () => page.mouse.wheel(+dx || 0, +dy || 0));
      return { mouse };
    },
    // Real pointer drag with intermediate moves (dnd-kit/Sortable/etc. need movement past an
    // activation distance — a teleport from A to B never starts a drag).
    drag: async ([a, b], o) => {
      const p1 = await point(a, o);
      const p2 = await point(b, { offset: o['to-offset'] });
      await withMods(o, async () => {
        await moveTo(p1, 3);
        await page.mouse.down({ button: o.button || 'left' });
        await sleep(num(o.hold, 50));
        await moveTo({ x: p1.x + 8, y: p1.y + 8 }, 3); // cross typical 5px activation threshold
        await moveTo(p2, num(o.steps, 25));
        await sleep(num(o.pause, 80));
        if (!o['no-release']) await page.mouse.up({ button: o.button || 'left' });
      });
      return { from: p1, to: p2, released: !o['no-release'] };
    },
    // ---- keyboard ----
    press: async ([key], o) => {
      for (let i = 0; i < num(o.repeat, 1); i++) await page.keyboard.press(key, { delay: num(o.delay, 30) });
      return { pressed: key };
    },
    keydown: async ([key]) => (await page.keyboard.down(key), { down: key }),
    keyup: async ([key]) => (await page.keyboard.up(key), { up: key }),
    type: async ([text], o) => (await page.keyboard.type(text, { delay: num(o.delay, 20) }), { typed: text }),
    // ---- touch (CDP, multi-touch capable) ----
    tap: async ([t], o) => {
      await ensureTouch();
      const p = await point(t, o);
      await touch('touchStart', [p]);
      await sleep(num(o.ms, 60));
      await touch('touchEnd', []);
      return { at: p };
    },
    // Report the timing the PAGE actually got: each CDP dispatch waits for the
    // page to handle the event, so a busy main thread (e.g. a WebGL app with a
    // continuous render loop) stretches taps far past --ms/--gap and the app's
    // double-tap window silently misses. The target resolves once, up front.
    dtap: async ([t], o) => {
      await ensureTouch();
      const p = await point(t, o);
      const hold = num(o.ms, 60);
      const tapOnce = async () => {
        const down = Date.now();
        await touch('touchStart', [p]);
        await sleep(hold);
        const upSent = Date.now();
        await touch('touchEnd', []);
        return { down, upSent, upDone: Date.now() };
      };
      const a = await tapOnce();
      await sleep(num(o.gap, 120));
      const secondDown = Date.now();
      await touch('touchStart', [p]);
      const secondLanded = Date.now();
      await sleep(hold);
      await touch('touchEnd', []);
      const downUpMs = [a.upDone - a.down, Date.now() - secondDown];
      // Upper bound on the release → next-touch gap the page observed.
      const gapMs = secondLanded - a.upSent;
      const r = { at: p, downUpMs, gapMs };
      if (gapMs > 300) {
        r.warning = `double-tap gap ${gapMs}ms > 300ms (typical double-tap window) — page main thread is slow to handle input; the app likely saw two single taps`;
      }
      return r;
    },
    longpress: async ([t], o) => {
      await ensureTouch();
      const p = await point(t, o);
      await touch('touchStart', [p]);
      await sleep(num(o.ms, 700));
      if (!o['no-release']) await touch('touchEnd', []);
      return { at: p, heldMs: num(o.ms, 700) };
    },
    swipe: async ([a, b], o) => {
      await ensureTouch();
      const p1 = await point(a, o);
      const p2 = await point(b, { offset: o['to-offset'] });
      await touch('touchStart', [p1]);
      await sleep(num(o.hold, 0));
      await touchPath([p1], [p2], num(o.ms, 250));
      await touch('touchEnd', []);
      return { from: p1, to: p2 };
    },
    // Finger drag: press, optionally hold (long-press-to-lift), move slowly, release.
    tdrag: async ([a, b], o) => verbs.swipe([a, b], { ...o, hold: num(o.hold, 300), ms: num(o.ms, 500) }),
    pinch: async ([t], o) => {
      await ensureTouch();
      const c = await point(t || `${page.viewportSize().width / 2},${page.viewportSize().height / 2}`, o);
      const d0 = num(o.dist, 120) / 2;
      const d1 = d0 * num(o.scale, 2);
      const from = [{ x: c.x - d0, y: c.y }, { x: c.x + d0, y: c.y }];
      const to = [{ x: c.x - d1, y: c.y }, { x: c.x + d1, y: c.y }];
      await touch('touchStart', from);
      await touchPath(from, to, num(o.ms, 400));
      await touch('touchEnd', []);
      return { center: c, scale: num(o.scale, 2) };
    },
    pan2: async ([a, b], o) => {
      await ensureTouch();
      const p1 = await point(a, o);
      const p2 = await point(b);
      const g = num(o.gap, 60) / 2;
      const from = [{ x: p1.x - g, y: p1.y }, { x: p1.x + g, y: p1.y }];
      const to = [{ x: p2.x - g, y: p2.y }, { x: p2.x + g, y: p2.y }];
      await touch('touchStart', from);
      await touchPath(from, to, num(o.ms, 400));
      await touch('touchEnd', []);
      return { from: p1, to: p2 };
    },
    // Raw escape hatch: web-playtest touch start|move|end '[{"x":1,"y":2},...]'
    touch: async ([type, pts]) => {
      await ensureTouch();
      // Points: literal JSON, or '@<js expr>' evaluated in the page that returns
      // an array of {x,y} (computed targets for canvas apps, like other verbs).
      const points =
        type === 'end'
          ? []
          : String(pts).startsWith('@')
            ? await page.evaluate(String(pts).slice(1))
            : JSON.parse(pts);
      await touch(`touch${type[0].toUpperCase()}${type.slice(1)}`, points);
      return { type };
    },
    stop: async () => {
      setTimeout(async () => {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
        fs.rmSync(statePath(session), { force: true });
        process.exit(0);
      }, 50);
      return { stopped: session, video: opts.video ? path.resolve(String(opts.video)) : undefined };
    },
  };

  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (d) => (buf += d));
    req.on('end', async () => {
      let out;
      try {
        const { cmd, pos, opts: o } = JSON.parse(buf);
        const fn = verbs[cmd];
        if (!fn) throw new Error(`unknown verb "${cmd}"`);
        out = { ok: true, cmd, ...(await fn(pos || [], o || {})) };
      } catch (e) {
        out = { ok: false, error: String(e.message || e).split('\n')[0] };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out));
    });
  });
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(statePath(session), JSON.stringify({ port: server.address().port, pid: process.pid, url, device, startedAt: new Date().toISOString() }));
  });
  browser.on('disconnected', () => (fs.rmSync(statePath(session), { force: true }), process.exit(1)));
}

// ---------- main ----------
const HELP = fs.readFileSync(path.join(path.dirname(SELF), 'help.txt'), 'utf8');

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opts } = parseArgs(rest);
  const session = String(opts.session || process.env.WEB_PLAYTEST_SESSION || 'default');
  delete opts.session;
  if (!cmd || cmd === 'help' || cmd === '--help') return void process.stdout.write(HELP);
  if (cmd === '_serve') return serve(pos[0], { ...opts, session });
  if (cmd === 'start') return void console.log(JSON.stringify({ ok: true, session, ...(await start(session, pos, opts)) }));
  if (cmd === 'sessions') {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const list = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json')).map((f) => ({ session: f.slice(0, -5), ...JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8')) }));
    return void console.log(JSON.stringify(list, null, 1));
  }
  if (cmd === 'run') {
    // Script file: one command per line, same syntax as the CLI minus "web-playtest". # comments.
    const lines = fs.readFileSync(pos[0], 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    let failed = 0;
    for (const line of lines) {
      const [c, ...r] = splitLine(line);
      const p = parseArgs(r);
      delete p.opts.session;
      const out = await send(session, c, p.pos, p.opts);
      console.log(JSON.stringify({ line, ...out }));
      if (!out.ok) {
        failed++;
        if (!opts['keep-going']) break;
      }
    }
    process.exitCode = failed ? 1 : 0;
    return;
  }
  const out = await send(session, cmd, pos, opts);
  console.log(JSON.stringify(out, null, out.events || out.aria || out.lines ? 1 : 0));
  if (!out.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`web-playtest: ${e.message}`);
  process.exit(1);
});
