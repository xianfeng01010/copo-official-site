"use strict";
/* =====================================================================
 * Copo 官网首页 · 交互机器人体验层
 * 依赖：robot.js（globalThis.CopoRobot，官方剪辑驱动引擎 v2）
 *       website.js 先行渲染 #main 并暴露 globalThis.CopoWebsite.text
 * 职责：随机安全锚点出没与游走、指针注视/靠近反应、点击戳动、拖拽投掷、
 *       滚动反应、闲置入睡与唤醒、区块感知气泡、移动端与 reduced-motion 合规。
 * 结构：纯逻辑挂 globalThis.CopoWebsiteRobotLogic（可单测）；DOM 层自守卫，
 *       首页以外/依赖缺失时静默不渲染，不影响页面其余功能。
 * ===================================================================== */
(() => {
  /* ---------------- 纯逻辑（供 vm 单测） ---------------- */
  const INTERACTIVE = "a,button,input,textarea,select,label,summary,[role=button],[contenteditable=true]";
  const isInteractiveEl = el => !!(el && el.closest && el.closest(INTERACTIVE));
  /* 禁停区：交互物之外，标题/段落/列表等文本块也不停靠（视觉验收：机器人不得压住正文文案） */
  const NO_STOP = INTERACTIVE + ",h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dt,dd,td,th";
  const isBlockedEl = el => !!(el && el.closest && el.closest(NO_STOP));
  /* 官方注视公式（xx）：[(px-cx)/(w*2), -(py-cy)/(w*2)]，钳制 ±1 */
  function gazeFrom(rect, px, py) {
    const clamp = v => Math.max(-1, Math.min(1, v));
    const w = Math.max(1, rect.width);
    return [clamp((px - (rect.left + w / 2)) / (w * 2)), clamp(-(py - (rect.top + rect.height / 2)) / (w * 2))];
  }
  /* 锚点过滤：探测函数 probe(x,y) 返回命中元素；交互物/文本块/空值剔除 */
  function filterAnchors(candidates, probe) {
    return candidates.filter(pt => {
      const el = probe(pt.x, pt.y);
      return !!el && !isBlockedEl(el);
    });
  }
  function pickAnchor(list, rng, avoid) {
    if (!list.length) return null;
    let pool = list.length > 1 && avoid != null ? list.filter(p => p !== avoid) : list;
    if (!pool.length) pool = list;
    return pool[Math.floor(rng() * pool.length) % pool.length];
  }
  function wanderDelay(rng, min = 14, max = 22) { return (min + rng() * (max - min)) * 1000; }
  /* 自主生命感：漂浮（慢正弦微位移）与呼吸（尺度起伏），叠加在锚点之上不参与碰撞 */
  function floatDrift(t, amp = 1) {
    return [Math.sin(t * .0011) * 3.5 * amp, Math.sin(t * .0007 + 1.3) * 2.5 * amp];
  }
  function breath(t, amp = 1) { return 1 + Math.sin(t * .0016) * .015 * amp; }
  /* 自主行为调度：加权随机选择下一个"自己会做的小动作" */
  const AMBIENT = [["gaze", .28], ["hum", .18], ["step", .18], ["tilt", .13], ["listen", .13], ["morph", .1]];
  function pickAmbient(rng) {
    let r = rng() * AMBIENT.reduce((s, a) => s + a[1], 0);
    for (const [k, w] of AMBIENT) { if ((r -= w) < 0) return k; }
    return "gaze";
  }
  function ambientDelay(rng, min = 4, max = 9) { return (min + rng() * (max - min)) * 1000; }
  /* 闲置阶段：<30s 无、<60s drowsy、≥60s sleeping */
  function idleStage(idleMs, drowsyAt = 30000, sleepAt = 60000) {
    if (idleMs >= sleepAt) return "sleeping";
    if (idleMs >= drowsyAt) return "drowsy";
    return null;
  }
  function springStep(pos, vel, target, dt, k = 170, c = 16) {
    const duration = Math.max(0, Math.min(.05, dt)), n = Math.max(1, Math.ceil(duration * 120)), h = duration / n;
    let [x,y] = pos, [vx,vy] = vel;
    for (let i = 0; i < n; i++) { vx += ((target[0]-x)*k-c*vx)*h; vy += ((target[1]-y)*k-c*vy)*h; x += vx*h; y += vy*h; }
    return [x,y,vx,vy];
  }
  function softBounds(pos, vel, box, bounce = .55) {
    let { x, y, vx, vy } = { x: pos[0], y: pos[1], vx: vel[0], vy: vel[1] }, hit = 0;
    if (x < box[0]) { x = box[0]; if (vx < 0) { vx *= -bounce; hit = 1; } }
    if (x > box[2]) { x = box[2]; if (vx > 0) { vx *= -bounce; hit = 1; } }
    if (y < box[1]) { y = box[1]; if (vy < 0) { vy *= -bounce; hit = 1; } }
    if (y > box[3]) { y = box[3]; if (vy > 0) { vy *= -bounce; hit = 1; } }
    return { x, y, vx, vy, hit };
  }
  function dragMood({ heldMs = 0, reversals = 0, speed = 0, edgePress = false } = {}) {
    if (reversals >= 6 && heldMs > 2200) return "confused";
    if (edgePress || speed > 2.2) return "suspicious";
    if (heldMs > 5200) return "bored";
    return "scared";
  }
  function dropMood(speed = 0) {
    if (speed > 1.8) return "scared";
    if (speed > .55) return "laughing";
    return "approving";
  }
  const logic = { gazeFrom, filterAnchors, pickAnchor, wanderDelay, idleStage, isInteractiveEl, isBlockedEl,
    floatDrift, breath, pickAmbient, ambientDelay, springStep, softBounds, dragMood, dropMood };
  globalThis.CopoWebsiteRobotLogic = logic;

  /* ---------------- DOM 层 ---------------- */
  const robot = globalThis.CopoRobot;
  const site = globalThis.CopoWebsite;
  if (!robot || !site || document.body.dataset.page !== "home") return;
  const t = path => site.text(path);
  const label = t("landing.robot.label");
  if (!label) return; /* 文案缺失时静默退出 */

  let reduced = !!(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const finePointer = !!(typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches);
  const isMobile = () => innerWidth < 720;
  const SIZE = () => (isMobile() ? 52 : 72);
  const rng = Math.random;
  const events = new AbortController(), timers = new Set(), intervals = new Set();
  let disposed = false, visible = true, frameId = 0, motion = null, observer = null, compact = false, stages = null;
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); if (!disposed) fn(); }, ms); timers.add(id); return id; };
  const every = (fn, ms) => { const id = setInterval(fn, ms); intervals.add(id); return id; };
  const on = (node, name, fn, options = {}) => node.addEventListener(name, fn, { ...options, signal: events.signal });
  const performing = () => !!motion?.active || !!motion?.hidden;


  /* 配色：与官网 tokens 同源（墨色机身 + 纸白眼睛 + 苔绿点缀） */
  const cssVar = name => getComputedStyle(document.body).getPropertyValue(name).trim();
  const ink = cssVar("--copo-ink") || "#202e2b";
  const bg = cssVar("--copo-bg") || "#ece6e8";
  const accent = cssVar("--copo-accent") || "#246b54";

  const layer = document.createElement("div");
  layer.id = "copo-robot-layer";
  layer.style.setProperty("--copo-robot-size", SIZE()+"px");
  layer.setAttribute("aria-hidden", "false");
  const hit = document.createElement("button");
  hit.type = "button";
  hit.id = "copo-robot-hit";
  hit.className = "copo-robot-hit";
  hit.setAttribute("aria-label", label);
  hit.title = label;
  const host = document.createElement("span");
  host.className = "copo-robot-host";
  host.setAttribute("aria-hidden", "true");
  const character = document.createElement('div');
  character.className = 'copo-robot-character';
  character.append(host, hit);
  const bubble = document.createElement("span");
  bubble.id = "copo-robot-bubble";
  bubble.className = "copo-robot-bubble";
  bubble.setAttribute("role", "status");
  bubble.setAttribute("aria-live", "polite");
  layer.appendChild(character);
  layer.appendChild(bubble);
  document.body.appendChild(layer);

  if (!robot.mount(host, { size: SIZE(), ink, bg, accent, shadow: "rgba(32, 46, 43, .22)" })) return;
  robot.setState("humming");

  /* ---- 位置与锚点 ---- */
  const state = {
    x: 0, y: 0, anchor: null,
    drag: null, fly: null,                             /* 拖拽 / 投掷 */
    step: null, ambientAt: 0,                          /* 自主小动作：微徘徊 / 下次调度时刻 */
    idleAt: performance.now(), lastPointer: null,
    pokeCount: 0, busyUntil: 0, mode: "free",
    bubbleUntil: 0, lastBubbleAt: 0,
    sectionSeen: {}, wanderAt: 0, curious: false, squintSince: 0,
  };
  const pad = () => Math.round(SIZE() * .6);
  const safeB = () => parseFloat(cssVar("--copo-robot-safe-b")) || 0;
  const clampX = x => Math.max(pad(), Math.min(innerWidth - SIZE() - pad(), x));
  const clampY = y => Math.max(84, Math.min(innerHeight - SIZE() - pad() - safeB(), y));

  function probe(x, y) {
    const prev = layer.style.visibility;
    layer.style.visibility = "hidden";
    const el = document.elementFromPoint(x, y);
    layer.style.visibility = prev;
    return el;
  }
  function sectionCandidates() {
    const pts = [];
    const vw = innerWidth, vh = innerHeight;
    if (isMobile()) {
      /* 移动端：底部两角（safe-area 由 CSS 底距承担），不遮挡中栏内容 */
      pts.push({ x: vw - SIZE() - 20, y: vh - SIZE() - 96 }, { x: 20, y: vh - SIZE() - 150 });
      return filterAnchors(pts.map(p => ({ x: clampX(p.x), y: clampY(p.y) })), probe);
    }
    const sections = [...document.querySelectorAll("main section, main .workbench-anchor")];
    const vis = sections.filter(s => { const r = s.getBoundingClientRect(); return r.bottom > 120 && r.top < vh - 80; });
    for (const s of vis.slice(0, 4)) {
      const r = s.getBoundingClientRect();
      const side = Math.random() < .5 ? 1 : -1;
      pts.push(
        { x: side > 0 ? vw - SIZE() * 1.4 : SIZE() * .4, y: r.top + r.height * .3 },
        { x: side > 0 ? vw - SIZE() * 1.4 : SIZE() * .4, y: r.top + r.height * .7 },
        { x: vw * (.24 + rng() * .5), y: Math.max(90, r.top - SIZE() * .5) }, /* 区块间隙 */
      );
    }
    return filterAnchors(pts.map(p => ({ x: clampX(p.x), y: clampY(p.y) })), probe);
  }
  function place(pt) { state.x = pt.x; state.y = pt.y; state.anchor = pt; }
  function teleport(pt) {
    place(pt); layer.style.transform = `translate3d(${pt.x}px, ${pt.y}px, 0)`;
    if (!motion?.hidden) motion?.controller.show();
  }
  function spawn() { const a = pickAnchor(sectionCandidates(), rng, null); place(a || { x: innerWidth - SIZE() * 1.6, y: innerHeight * .4 }); }
  spawn();

  /* ---- 气泡 ---- */
  let bubbleTimer = 0;
  function showBubble(text, ms = 4000) {
    const now = performance.now();
    if (now - state.lastBubbleAt < 60000) return false;
    state.lastBubbleAt = now; state.bubbleUntil = now + ms;
    bubble.textContent = text;
    layer.classList.add("copo-robot-bubbling");
    clearTimeout(bubbleTimer);
    bubbleTimer = later(() => layer.classList.remove("copo-robot-bubbling"), ms);
    return true;
  }

  /* ---- 反应调度：transient 优先于游走/入睡；到期自动回落基态 ---- */
  function react(key, ms) {
    if (performing()) return;
    robot.setState(key);
    state.busyUntil = performance.now() + ms;
    state.mode = "react";
  }
  const idleish = () => ["idle", "humming", "listening", "thinking", "waiting"].includes(robot.state);
  /* 反应到期恢复 free 并回基态（happy/laughing/scared 等无 next 的状态不会自己走） */
  function settleReact(now) {
    if (state.mode === "react" && now > state.busyUntil) state.mode = "free";
    if (state.mode === "free" && now > state.busyUntil && !idleish() && !robot.gating && !state.drag && !state.fly)
      robot.setState("idle");
  }

  /* ---- 指针：注视 + 靠近（桌面） ---- */
  let pointerRaf = 0, lastMove = 0;
  function onPointerMove(e) {
    state.lastPointer = { x: e.clientX, y: e.clientY };
    state.idleAt = performance.now();
    if (state.mode === "sleep") wake();
    if (pointerRaf || reduced || isMobile() || performing() || !visible) return;
    lastMove = e.clientX + e.clientY;
    pointerRaf = requestAnimationFrame(() => {
      pointerRaf = 0;
      const p = state.lastPointer; if (!p) return;
      const rect = host.getBoundingClientRect();
      const [gx, gy] = logic.gazeFrom(rect, p.x, p.y);
      robot.look(gx, gy, 1.1);
      if (state.drag || state.mode === "sleep") return;
      const d = Math.hypot(p.x - (rect.left + rect.width / 2), p.y - (rect.top + rect.height / 2));
      if (d < 150 && idleish() && !state.curious) { state.curious = true; react("curious", 1600); }
      else if (d > 230 && state.curious && idleish()) { state.curious = false; robot.setState("idle"); }
    });
  }
  on(globalThis, "pointermove", onPointerMove, { passive: true });
  on(globalThis, "keydown", () => { state.idleAt = performance.now(); if (state.mode === "sleep") wake(); }, { passive: true });

  /* ---- 点击/键盘：随机戳动；每 5 次庆祝 + 星光 ---- */
  const POKES = [["spin", { turns: 2 }], ["spin", { turns: 1 }], ["bounce", null], ["nod", null], ["nod", null]];
  function celebrate() {
    react("celebrate", 3200);
    robot.setBody("sparkle", 2.6);
    robot.burst(16);
    showBubble(t("landing.robot.celebrate"), 3200);
  }
  function pokeOnce() {
    state.pokeCount += 1;
    state.idleAt = performance.now();
    if (state.pokeCount % 5 === 0) return celebrate();
    const [kind, opts] = POKES[Math.floor(rng() * POKES.length)];
    robot.poke(kind, opts || undefined);
    state.busyUntil = performance.now() + 800;
  }
  on(hit, "click", e => {
    if (suppressClick || (state.drag && state.drag.moved)) { suppressClick = false; return; } /* 拖拽结束不触发点击 */
    stages?.suspend(8000); pokeOnce();
  });

  /* Drag uses the latest main's spring interaction, integrated by our single owner loop. */
  let suppressClick = false;
  hit.style.touchAction = "none";
  const physicalBounds = () => { const b = stages?.frameBounds() || motion?.viewport(); return b ? [b.left,b.top,Math.max(b.left,b.right),Math.max(b.top,b.bottom)] : [pad(),90,innerWidth-SIZE()-pad(),innerHeight-SIZE()-90]; };
  on(hit, "pointerdown", e => {
    if (e.button !== 0 || motion?.hidden || reduced) return;
    stages?.suspend(8000); motion?.controller.cancel(); suppressClick = false;
    e.preventDefault();
    try { hit.setPointerCapture(e.pointerId); } catch (_) {}
    state.drag = { ox:e.clientX-state.x, oy:e.clientY-state.y, tx:state.x, ty:state.y, svx:0, svy:0,
      heldAt:performance.now(), reversals:0, lastDir:0, moved:false, moodAt:0 };
    state.mode = "drag"; state.fly = null; state.step = null; robot.setPaused?.(false);robot.setState("curious");startFrame();
  });
  on(hit, "pointermove", e => {
    const d = state.drag; if (!d) return;
    d.tx = e.clientX-d.ox; d.ty = e.clientY-d.oy;
    const dir = Math.sign(e.movementX || d.tx-state.x);
    if (dir && d.lastDir && dir!==d.lastDir && Math.abs(d.tx-state.x)>8) d.reversals++;
    if (dir) d.lastDir = dir;
    if (Math.hypot(d.tx-state.x,d.ty-state.y)>6) d.moved = true;
    state.idleAt = performance.now();
  });
  function stepDrag(dt, now) {
    const d = state.drag; if (!d) return;
    let dx=d.tx-state.x,dy=d.ty-state.y,lead=Math.hypot(dx,dy),target=[d.tx,d.ty];
    if (lead>260) target=[state.x+dx/lead*260,state.y+dy/lead*260];
    const p=logic.springStep([state.x,state.y],[d.svx,d.svy],target,dt);
    const b=logic.softBounds(p.slice(0,2),p.slice(2).map(v=>Math.max(-2400,Math.min(2400,v))),physicalBounds());
    state.x=b.x;state.y=b.y;d.svx=b.vx;d.svy=b.vy;
    if (b.hit) robot.poke('squash');
    const speed=Math.hypot(d.svx,d.svy)/1000;
    robot.stretch?.(Math.min(.22,speed*.12),Math.atan2(d.svy,d.svx)*180/Math.PI);
    if (now-d.moodAt>400 && d.moved) { const mood=logic.dragMood({heldMs:now-d.heldAt,reversals:d.reversals,speed,edgePress:!!b.hit});if(robot.state!==mood)robot.setState(mood);d.moodAt=now; }
  }
  function endDrag(e) {
    const d=state.drag;if(!d)return;state.drag=null;suppressClick=d.moved;state.mode='free';state.idleAt=performance.now();
    if(!d.moved){robot.setState('idle');robot.stretch?.(0,0);return;}
    const speed=Math.hypot(d.svx,d.svy)/1000;
    if(speed<.18){robot.stretch?.(0,0);react('approving',1200);robot.poke('nod');}
    else{state.fly={vx:d.svx*.88,vy:d.svy*.88,bornAt:performance.now(),restFor:0};robot.setState(logic.dropMood(speed));}
    scheduleWander();
  }
  on(hit,'pointerup',endDrag);on(hit,'pointercancel',endDrag);

  /* ---- 滚动反应 ---- */
  let lastScrollY = scrollY, scrollLastT = performance.now(), scrollRaf = 0;
  on(globalThis, "scroll", () => {
    if (scrollRaf || reduced || performing() || !visible) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const now = performance.now(), dt = Math.max(16, now - scrollLastT);
      const v = Math.abs(scrollY - lastScrollY) / dt * 1000;
      lastScrollY = scrollY; scrollLastT = now;
      state.idleAt = now; /* 滚动是活动，重置闲置计时 */
      if (state.mode === "drag" || state.mode === "sleep") return;
      if (v > 2600) react("surprised", 700);
      else if (v > 1400) {
        if (!state.squintSince) state.squintSince = now;
        else if (now - state.squintSince > 1200 && idleish()) react("suspicious", 1500);
      } else state.squintSince = 0;
    });
  }, { passive: true });

  /* ---- 闲置入睡 / 唤醒 ---- */
  function wake() {
    state.mode = "free";
    react("waking", 1600);
    layer.classList.remove("copo-robot-sleeping");
  }
  every(() => {
    if (stages || document.hidden || !visible || performing() || state.mode === "drag" || state.mode === "teleport" || state.fly) return;
    const now = performance.now();
    const stage = logic.idleStage(now - state.idleAt);
    if (state.mode === "sleep") return;
    if (stage === "sleeping") {
      state.mode = "sleep";
      robot.setState("sleeping");
      layer.classList.add("copo-robot-sleeping");
      showBubble(t("landing.robot.sleep"), 6000);
    } else if (stage === "drowsy" && idleish()) robot.setState("drowsy");
  }, 4000);

  /* ---- 区块感知气泡 ---- */
  const SECTION_HOOKS = [
    { id: "pricing", key: "pricing", state: "happy" },
    { id: "faq", key: "faq", state: "curious" },
    { id: "inquiry", key: "inquiry", state: "approving" },
  ];
  if ("IntersectionObserver" in globalThis && !reduced) {
    const seen = state.sectionSeen;
    const io = observer = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (!visible || performing() || !en.isIntersecting || en.intersectionRatio < .3) continue;
        const hook = SECTION_HOOKS.find(h => en.target.id === h.id);
        if (!hook || seen[hook.id] || state.mode === "drag" || state.mode === "sleep") continue;
        seen[hook.id] = true;
        if (performance.now() - state.lastBubbleAt < 180000) continue;
        react(hook.state, 2400);
        showBubble(t(`landing.robot.${hook.key}`), 4600);
      }
    }, { threshold: [.3, .6] });
    for (const h of SECTION_HOOKS) { const el = document.getElementById(h.id); if (el) io.observe(el); }
  }

  /* One position owner: shared motion while performing, gentle idle drift otherwise. */
  function scheduleWander() { state.wanderAt = performance.now() + 60000; }
  let frameLast = 0;
  function frame(now) {
    frameId = 0;
    if (disposed || document.hidden || !visible || reduced) return;
    if(stages&&!state.drag&&!state.fly){host.style.transform="";return;}
    if (!performing()) {
      const dt=frameLast?Math.min(.05,(now-frameLast)/1000):1/60;frameLast=now;
      if(state.drag)stepDrag(dt,now);
      if(state.fly){
        const f=state.fly,bounds=physicalBounds();f.vy+=1800*dt;f.vx*=Math.exp(-1.25*dt);
        if(state.y>=bounds[3]-1)f.vx*=Math.exp(-10*dt);
        const b=logic.softBounds([state.x+f.vx*dt,state.y+f.vy*dt],[f.vx,f.vy],bounds,.58);
        state.x=b.x;state.y=b.y;f.vx=b.vx;f.vy=b.vy;if(b.hit)robot.poke('squash');
        robot.stretch?.(Math.min(.2,Math.hypot(f.vx,f.vy)/10000),Math.atan2(f.vy,f.vx)*180/Math.PI);
        f.restFor=state.y>=bounds[3]-1&&Math.hypot(f.vx,f.vy)<100?f.restFor+dt:0;
        if(f.restFor>.15||now-f.bornAt>6000){state.fly=null;robot.stretch?.(0,0);react('laughing',1200);robot.poke('nod');}
      }
      const moving = state.drag ? {vx:state.drag.svx,vy:state.drag.svy} : state.fly;
      robot.setHeading?.(moving && Math.hypot(moving.vx, moving.vy) > .2 ? Math.atan2(moving.vy, moving.vx) : null);
      settleReact(now);
      const driftWeight = Math.min(1, (now - state.idleAt) / 450);
      const fd = stages?[0,0]:logic.floatDrift(now, (state.mode === "sleep" ? .45 : 1) * driftWeight);
      layer.style.transform = `translate3d(${(state.x + fd[0]).toFixed(2)}px, ${(state.y + fd[1]).toFixed(2)}px, 0)`;
      host.style.transform = stages?"":`scale(${logic.breath(now).toFixed(4)})`;
    }
    frameId = requestAnimationFrame(frame);
  }
  const startFrame = () => { if (!frameId && !disposed && visible && !reduced && !document.hidden) frameId = requestAnimationFrame(frame); };
  function stopLegacy() {
    for (const id of timers) clearTimeout(id); timers.clear();
    robot.stretch?.(0,0); frameLast=0;
    state.drag = null; state.fly = null; state.step = null;
    layer.classList.remove("copo-robot-bubbling", "copo-robot-sleeping");
    state.mode = "free"; state.busyUntil = performance.now() + 1000;
  }
  motion = globalThis.CopoRobotMotion?.attach({ target: layer, visual: character, robot, stageManaged: !!globalThis.CopoRobotStages,
    size: () => compact ? (isMobile() ? 36 : 64) : SIZE(), scale: () => (isMobile() ? 36 : 64) / SIZE(), read: () => ({ x: state.x, y: state.y }),
    write: p => { state.x = p.x; state.y = p.y; layer.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`; },
    before: action => { if(!['hop','depart','grip','show','hide'].includes(action))stages?.suspend(8000); stopLegacy(); compact = action === 'orbit'; },
    localBounds: () => stages?.bounds(), safe: p => stages?.safe(p)!==false, autoManaged: () => !!stages,
    ambient: () => {
      switch (logic.pickAmbient(rng)) {
        case 'gaze': robot.look((rng() * 2 - 1) * .9, (rng() * 2 - 1) * .35, 2); break;
        case 'hum': react('humming', 2600); robot.poke('nod'); break;
        case 'step': motion.controller.play('walk'); break;
        case 'tilt': robot.poke('nod'); break;
        case 'listen': robot.look(0, -.25, 2.2); react('listening', 2400); break;
        case 'morph': robot.setBody(['sparkle', 'star6', 'heart', 'gem', 'clover'][Math.floor(rng() * 5)], 3.5); robot.poke('spin', { turns: 1 }); break;
      }
    },
    idle: () => !state.drag && !state.fly && state.mode !== "react",
    restore: () => { compact = false; state.mode = "free"; state.idleAt = performance.now(); if (!robot.settledFor("idle")) robot.setState("idle"); },
    visibility: v => {
      visible = v;
      if (!v) { stopLegacy(); if (frameId) cancelAnimationFrame(frameId); frameId = 0; }
      else startFrame();
    },
    destroy: () => {
      disposed = true; stages?.destroy(); stopLegacy(); intervals.forEach(clearInterval); intervals.clear(); events.abort(); observer?.disconnect();
      if (frameId) cancelAnimationFrame(frameId); if (pointerRaf) cancelAnimationFrame(pointerRaf); if (scrollRaf) cancelAnimationFrame(scrollRaf);
      layer.remove();
    }
  });
  globalThis.CopoWebsiteRobotMotion = motion;
  if(motion&&globalThis.CopoRobotStages){
    stages=CopoRobotStages.attach({motion,robot,size:SIZE,viewport:motion.viewport,reduced:()=>reduced,
      busy:()=>!!state.drag||!!state.fly,rest:()=>{state.mode="free";robot.setState("idle");},
      respond:p=>{state.idleAt=performance.now();layer.classList.remove("copo-robot-sleeping");react(p.state,1600);}});
    globalThis.CopoWebsiteRobotStages=stages;
  }
  on(document, "visibilitychange", () => {
    if (document.hidden) { if (frameId) cancelAnimationFrame(frameId); frameId = 0; if (pointerRaf) cancelAnimationFrame(pointerRaf); pointerRaf = 0; if (scrollRaf) cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
    else startFrame();
  });
  const reducedMedia = matchMedia("(prefers-reduced-motion: reduce)");
  on(reducedMedia, "change", () => { reduced = reducedMedia.matches; if (frameId) cancelAnimationFrame(frameId); frameId = 0; host.style.transform = ""; stages?.invalidate(); startFrame(); });
  startFrame();
  let mountedSize = SIZE();
  on(globalThis, "resize", () => {
    state.x = clampX(state.x); state.y = clampY(state.y);
    const s = SIZE(); layer.style.setProperty("--copo-robot-size",s+"px");
    if (s !== mountedSize) { /* 跨移动/桌面断点（含手机横竖屏）：按新尺寸重挂 */
      mountedSize = s;
      const old = host.querySelector("canvas");
      if (old) old.remove();
      robot.mount(host, { size: s, ink, bg, accent, shadow: "rgba(32, 46, 43, .22)" });
      robot.setState(state.mode === "sleep" ? "sleeping" : "idle");
      robot.setVisible(visible);
    }
  }, { passive: true });

  /* Entry uses the same cancellable door sequence as recall. */
  if (reduced) layer.classList.add("copo-robot-still");
  else if (!stages && !motion?.hidden) motion?.controller.show();
})();
