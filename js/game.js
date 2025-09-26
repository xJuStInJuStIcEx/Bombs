// game.js — prototipo MVP per "Bombe"
// Sostituisci interamente il file precedente con questo.

// --- DOM refs
const playArea = document.getElementById('play-area');
const scoreEl = document.getElementById('score-value');
const disarmedEl = document.getElementById('disarmed');
const requiredEl = document.getElementById('required');
const timerEl = document.getElementById('timer-value');
const levelEl = document.getElementById('level-value');
const overlay = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlay-title');
const overlayStats = document.getElementById('overlay-stats');
const btnRestart = document.getElementById('btn-restart');
const btnNext = document.getElementById('btn-next');
const bonusesBar = document.getElementById('bonuses-bar');

// --- State
let state = {
  level: 1,
  timePerLevel: 60,
  R0: 5,
  deltaR: 3,
  score: 0,
  disarmed: 0,
  required: 5,
  bombs: new Map(),
  spawnIntervalHandle: null,
  levelTimerHandle: null,
  running: false,
  shieldActive: false,
  freezeUntil: 0,
  explosions: []
};

// unique id generator
const uid = (() => { let n = 0; return () => ++n; })();

// --- Audio (small synth/noise)
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playClickSound(){
  try{
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.value = 0.08;
    o.connect(g); g.connect(audioCtx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
    o.stop(audioCtx.currentTime + 0.13);
  }catch(e){}
}

function playExplosionSound(){
  try{
    const bufferSize = audioCtx.sampleRate * 0.18;
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i=0;i<bufferSize;i++){
      const t = i / bufferSize;
      data[i] = (Math.random()*2-1) * (1 - t) * Math.exp(-3*t);
    }
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer;
    const g = audioCtx.createGain();
    g.gain.value = 0.22;
    noise.connect(g); g.connect(audioCtx.destination);
    noise.start();
    noise.stop(audioCtx.currentTime + 0.22);
  }catch(e){}
}

// --- Explosion params (fixed)
const COLOR_MAX_RADIUS = { black: 50, red: 100, blue: 150 };
const EXPANSION_PER_FRAME = 5; // px/frame
const CHAIN_PENALTY = { black: 10, red: 15, blue: 20 };

// --- Game param helpers
function requiredForLevel(L){ return state.R0 + state.deltaR * (L - 1); }
function spawnIntervalForLevel(L){ return Math.max(350, 900 - (L-1)*60); }
function bombLifetimeForLevel(L){ return Math.max(1200, 4200 - (L-1)*300); }
function spawnChanceColorForLevel(L){
  const red = Math.min(0.25, 0.03 + 0.02 * (L-1));
  const blue = Math.min(0.45, 0.2 + 0.05 * (L-1));
  const black = Math.max(0, 1 - red - blue);
  return [black, blue, red];
}
function valueForColorAndLevel(color, L){
  if(color === 'black') return Math.random() < 0.85 ? 1 : 2;
  if(color === 'blue') return Math.random() < 0.65 ? 2 : 3;
  return Math.random() < 0.6 ? 3 : 4;
}
function multiplierForColor(color){
  if(color === 'black') return 1.0;
  if(color === 'blue') return 1.5;
  if(color === 'red') return 2.0;
  return 1.0;
}

// --- Positioning helpers
function getPlayAreaRect(){ return playArea.getBoundingClientRect(); }
function randomPosition(size){
  const pad = 8;
  const rect = getPlayAreaRect();
  const w = Math.max(260, rect.width);
  const h = Math.max(180, rect.height - 80);
  const x = Math.floor(Math.random() * (w - size - pad*2)) + pad;
  const y = Math.floor(Math.random() * (h - size - pad*2)) + pad;
  return {x,y};
}
function isTooClose(x,y,size){
  for(const b of state.bombs.values()){
    const dx = b.x - x;
    const dy = b.y - y;
    const dist = Math.hypot(dx,dy);
    if(dist < size * 0.9 + (b.size || 72)*0.9) return true;
  }
  return false;
}

// --- DOM helpers
function createBombElement(b){
  const el = document.createElement('div');
  el.className = `bomb ${b.color}`;
  el.style.width = `${b.size}px`;
  el.style.height = `${b.size}px`;
  el.style.left = `${b.x}px`;
  el.style.top = `${b.y}px`;
  el.dataset.id = b.id;
  el.innerHTML = `<div class="value">${b.currentValue}</div>`;
  el.addEventListener('pointerdown', onBombPointerDown);
  return el;
}

function createExplosionVisual(x,y){
  const e = document.createElement('div');
  e.className = 'explosion';
  e.style.left = `${x}px`;
  e.style.top = `${y}px`;
  playArea.appendChild(e);
  setTimeout(()=>{ if(e.parentElement) e.remove(); }, 520);
}

function createExplosionWaveDOM(x,y,initialRadius=0){
  const el = document.createElement('div');
  el.className = 'explosion-wave';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.width = `${initialRadius*2}px`;
  el.style.height = `${initialRadius*2}px`;
  playArea.appendChild(el);
  return el;
}

function createBonusElement(type, x, y){
  const el = document.createElement('div');
  el.className = 'bonus';
  el.dataset.type = type;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.innerText = (type === 'time' ? '+T' : type === 'score' ? '+P' : type === 'mult' ? '×' : type === 'shield' ? 'S' : '❄');
  el.addEventListener('pointerdown', onBonusPick);
  playArea.appendChild(el);
  setTimeout(()=>{ if(el.parentElement) el.remove(); }, 9000);
  return el;
}

// --- Bomb logic
function spawnBomb(){
  const id = uid();
  const size = 72;
  let pos = randomPosition(size);
  let attempts = 0;
  while(isTooClose(pos.x,pos.y,size) && attempts < 25){
    pos = randomPosition(size);
    attempts++;
  }
  const L = state.level;
  const [pBlack, pBlue, pRed] = spawnChanceColorForLevel(L);
  const r = Math.random();
  const color = r < pBlack ? 'black' : (r < pBlack + pBlue ? 'blue' : 'red');
  const value = valueForColorAndLevel(color, L);
  const multiplier = multiplierForColor(color);
  const lifetime = bombLifetimeForLevel(L);
  const createdAt = Date.now();

  const bomb = {
    id, x: pos.x, y: pos.y, size, color, originalValue: value,
    currentValue: value, multiplier, lifetime, createdAt, exploded:false,
    willExplode:false, dom:null, timerHandle:null
  };

  const el = createBombElement(bomb);
  playArea.appendChild(el);
  bomb.dom = el;
  state.bombs.set(id, bomb);

  scheduleBombTimer(bomb);
  return bomb;
}

function scheduleBombTimer(bomb){
  if(bomb.timerHandle) clearTimeout(bomb.timerHandle);
  const now = Date.now();
  const left = Math.max(0, bomb.lifetime - (now - bomb.createdAt));
  const fire = () => {
    if(!state.bombs.has(bomb.id)) return;
    if(Date.now() < state.freezeUntil){
      const remaining = Math.max(50, bomb.lifetime - (Date.now() - bomb.createdAt));
      bomb.timerHandle = setTimeout(fire, remaining + 50);
      return;
    }
    triggerExplosion(bomb.id, false);
  };
  bomb.timerHandle = setTimeout(fire, left);
}

function onBombPointerDown(e){
  if(audioCtx.state === 'suspended') audioCtx.resume();
  const id = this.dataset.id;
  const bomb = state.bombs.get(Number(id));
  if(!bomb) return;
  if(bomb.exploded || bomb.currentValue <= 0) return;

  bomb.currentValue -= 1;
  const valEl = bomb.dom.querySelector('.value');
  valEl.textContent = bomb.currentValue;
  playClickSound();

  if(bomb.currentValue <= 0){
    disarmBomb(bomb.id);
  } else {
    bomb.dom.style.transform = 'scale(0.98)';
    setTimeout(()=>{ if(bomb.dom) bomb.dom.style.transform = ''; }, 90);
  }
}

function disarmBomb(id){
  const bomb = state.bombs.get(Number(id));
  if(!bomb) return;
  if(bomb.timerHandle) clearTimeout(bomb.timerHandle);
  bomb.currentValue = 0;
  const pts = Math.round(bomb.originalValue * bomb.multiplier);
  state.score += pts;
  updateScoreUI();
  state.disarmed += 1;
  updateDisarmedUI();

  bomb.dom.classList.add('disarm');
  setTimeout(()=>{
    const dropRate = 0.28;
    if(Math.random() < dropRate){
      const types = ['time','score','mult','shield','freeze'];
      const pick = types[Math.floor(Math.random()*types.length)];
      createBonusElement(pick, bomb.x + bomb.size/4, bomb.y + bomb.size/4);
    }
    if(bomb.dom && bomb.dom.parentElement) bomb.dom.remove();
    state.bombs.delete(bomb.id);
  }, 320);
}

// triggerExplosion(id, chained=false)
function triggerExplosion(id, chained = false){
  const bomb = state.bombs.get(Number(id));
  if(!bomb) return;
  if(bomb.exploded) return;
  bomb.exploded = true;

  const color = bomb.color || 'black';
  if(bomb.timerHandle) clearTimeout(bomb.timerHandle);
  if(bomb.dom && bomb.dom.parentElement) bomb.dom.remove();

  const cx = bomb.x + bomb.size/2;
  const cy = bomb.y + bomb.size/2;

  createExplosionVisual(cx, cy);
  if(audioCtx.state === 'suspended') audioCtx.resume().then(()=>playExplosionSound()).catch(()=>playExplosionSound());
  else playExplosionSound();

  if(state.shieldActive){
    state.shieldActive = false;
    updateBonusesUI();
  } else {
    if(!chained){
      state.score = Math.floor(state.score / 2);
      updateScoreUI();
    } else {
      const pen = CHAIN_PENALTY[color] || 10;
      state.score = Math.max(0, state.score - pen);
      updateScoreUI();
    }
  }

  const maxR = COLOR_MAX_RADIUS[color] || 50;
  createExplosionWave(cx, cy, maxR);
  state.bombs.delete(bomb.id);
}

function createExplosionWave(x,y,maxRadius){
  const dom = createExplosionWaveDOM(x,y,0);
  const expl = { x,y, radius:0, maxRadius, expansionSpeed:EXPANSION_PER_FRAME, dom, active:true };
  state.explosions.push(expl);
}

function updateExplosions(){
  if(state.explosions.length === 0) return;
  const toTriggerNext = new Set();

  for(const expl of state.explosions){
    if(!expl.active) continue;
    expl.radius += expl.expansionSpeed;
    const d = Math.max(0, expl.radius * 2);
    if(expl.dom){
      expl.dom.style.width = `${d}px`;
      expl.dom.style.height = `${d}px`;
      const t = Math.max(0, 1 - expl.radius / expl.maxRadius);
      expl.dom.style.opacity = `${0.45 * t + 0.15}`;
    }

    for(const b of state.bombs.values()){
      if(b.exploded || b.willExplode) continue;
      const bx = b.x + b.size/2;
      const by = b.y + b.size/2;
      const dx = bx - expl.x;
      const dy = by - expl.y;
      const dist = Math.hypot(dx, dy);
      const bombRadius = b.size / 2;
      if(dist <= expl.radius + bombRadius){
        b.willExplode = true;
        toTriggerNext.add(b.id);
      }
    }

    if(expl.radius >= expl.maxRadius){
      expl.active = false;
      if(expl.dom && expl.dom.parentElement) expl.dom.remove();
    }
  }

  state.explosions = state.explosions.filter(e => e.active);

  if(toTriggerNext.size > 0){
    setTimeout(()=>{
      for(const bid of toTriggerNext){
        const b = state.bombs.get(bid);
        if(!b) continue;
        b.willExplode = false;
        triggerExplosion(bid, true);
      }
    }, 0);
  }
}

// --- bonuses
function onBonusPick(e){
  const el = this;
  const type = el.dataset.type;
  applyBonus(type);
  if(el && el.parentElement) el.remove();
}

function applyBonus(type){
  switch(type){
    case 'time':
      state.levelEndAt += 6000;
      break;
    case 'score':
      state.score += 12;
      updateScoreUI();
      break;
    case 'mult':
      state.runningMult = (state.runningMult || 1) + 0.3;
      setTimeout(()=>{ state.runningMult = Math.max(1, (state.runningMult || 1) - 0.3); }, 8000);
      break;
    case 'shield':
      state.shieldActive = true;
      updateBonusesUI();
      break;
    case 'freeze':
      state.freezeUntil = Date.now() + 3500;
      for(const b of state.bombs.values()) scheduleBombTimer(b);
      break;
    default:
      break;
  }
  flashHUD();
}

function updateBonusesUI(){
  bonusesBar.innerHTML = '';
  if(state.shieldActive){
    const s = document.createElement('div');
    s.className = 'bonus';
    s.style.width = '36px';
    s.style.height = '36px';
    s.style.display = 'inline-flex';
    s.style.alignItems = 'center';
    s.style.justifyContent = 'center';
    s.style.marginLeft = '8px';
    s.textContent = 'S';
    bonusesBar.appendChild(s);
  }
}

function flashHUD(){
  const el = document.getElementById('hud');
  if(!el) return;
  el.style.transition = 'box-shadow 160ms';
  el.style.boxShadow = '0 0 18px rgba(255,200,60,0.12)';
  setTimeout(()=>{ if(el) el.style.boxShadow = ''; }, 180);
}

// --- UI updates
function updateScoreUI(){ scoreEl.textContent = String(state.score); }
function updateDisarmedUI(){ disarmedEl.textContent = String(state.disarmed); }
function updateRequiredUI(){ requiredEl.textContent = String(state.required); }
function updateLevelUI(){ levelEl.textContent = String(state.level); }

// --- Level management
function startLevel(L = 1){
  resetLevelState(L);
  state.running = true;
  updateScoreUI(); updateDisarmedUI(); updateRequiredUI(); updateLevelUI();
  overlay.classList.add('hidden');

  const spawnMs = spawnIntervalForLevel(L);
  state.spawnIntervalHandle = setInterval(()=>{
    const maxOnScreen = Math.min(12 + L*2, 28);
    if(state.bombs.size < maxOnScreen && Date.now() >= state.freezeUntil){
      spawnBomb();
    }
  }, Math.max(220, spawnMs));

  const now = Date.now();
  state.levelEndAt = now + state.timePerLevel * 1000;
  timerTick();
  state.levelTimerHandle = setInterval(timerTick, 200);
}

function timerTick(){
  const remainingMs = Math.max(0, state.levelEndAt - Date.now());
  const remSec = Math.ceil(remainingMs / 1000);
  timerEl.textContent = String(remSec);
  if(remainingMs <= 0) finishLevel();
}

function finishLevel(){
  if(state.spawnIntervalHandle) clearInterval(state.spawnIntervalHandle);
  if(state.levelTimerHandle) clearInterval(state.levelTimerHandle);
  state.spawnIntervalHandle = null;
  state.levelTimerHandle = null;
  state.running = false;

  const success = state.disarmed >= state.required;
  for(const b of state.bombs.values()){
    if(b.timerHandle) clearTimeout(b.timerHandle);
    if(b.dom && b.dom.parentElement) b.dom.remove();
  }
  state.bombs.clear();

  for(const ex of state.explosions){
    if(ex.dom && ex.dom.parentElement) ex.dom.remove();
  }
  state.explosions = [];

  showOverlay(success);
}

function resetLevelState(L){
  if(state.spawnIntervalHandle) clearInterval(state.spawnIntervalHandle);
  if(state.levelTimerHandle) clearInterval(state.levelTimerHandle);
  for(const b of state.bombs.values()){
    if(b.timerHandle) clearTimeout(b.timerHandle);
    if(b.dom && b.dom.parentElement) b.dom.remove();
  }
  state.bombs.clear();

  for(const ex of state.explosions){
    if(ex.dom && ex.dom.parentElement) ex.dom.remove();
  }
  state.explosions = [];

  state.level = L;
  state.score = state.score || 0;
  state.disarmed = 0;
  state.required = requiredForLevel(L);
  state.shieldActive = false;
  state.freezeUntil = 0;
  state.runningMult = 1;
}

// --- Overlay / UI controls
function showOverlay(success){
  overlay.classList.remove('hidden');
  overlayTitle.textContent = success ? 'Livello superato!' : 'Game Over';
  overlayStats.innerHTML = `
    Livello ${state.level} — Bombe disinnescate: ${state.disarmed}/${state.required}<br>
    Punteggio: ${state.score}
  `;
  if(success){
    btnNext.classList.remove('hidden');
    btnRestart.classList.add('hidden');
  } else {
    btnNext.classList.add('hidden');
    btnRestart.classList.remove('hidden');
  }
}

btnRestart.addEventListener('click', ()=>{
  overlay.classList.add('hidden');
  startLevel(state.level);
});

btnNext.addEventListener('click', ()=>{
  overlay.classList.add('hidden');
  startLevel(state.level + 1);
});

// --- Animation loop for explosions
function gameLoop(){
  updateExplosions();
  requestAnimationFrame(gameLoop);
}

// --- Init and start button (must exist and be visible)
function init(){
  state.required = requiredForLevel(state.level);
  updateRequiredUI();
  updateLevelUI();

  // Start button (shown before game starts)
  const startBtn = document.createElement('button');
  startBtn.textContent = 'Avvia (clicca/tocca per iniziare)';
  startBtn.style.position = 'absolute';
  startBtn.style.left = '50%';
  startBtn.style.top = '50%';
  startBtn.style.transform = 'translate(-50%,-50%)';
  startBtn.style.zIndex = 9999;
  startBtn.style.padding = '12px 16px';
  startBtn.style.borderRadius = '10px';
  playArea.appendChild(startBtn);

  startBtn.addEventListener('click', async () => {
    if(audioCtx.state === 'suspended') try{ await audioCtx.resume(); }catch(e){}
    startBtn.remove();
    startLevel(1);
    requestAnimationFrame(gameLoop);
  });
}

init();// Utility: generate unique ids
const uid = (()=>{let n=0; return ()=>++n})();

// --- Sound synthesis (very small, no files) ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playClickSound(){
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = 'sine';
  o.frequency.value = 880;
  g.gain.value = 0.08;
  o.connect(g); g.connect(audioCtx.destination);
  o.start();
  g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
  o.stop(audioCtx.currentTime + 0.13);
}

function playExplosionSound(){
  // short noise burst
  const bufferSize = audioCtx.sampleRate * 0.18;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i=0;i<bufferSize;i++){
    const t = i / bufferSize;
    data[i] = (Math.random()*2-1) * (1 - t) * Math.exp(-3*t);
  }
  const noise = audioCtx.createBufferSource();
  noise.buffer = buffer;
  const g = audioCtx.createGain();
  g.gain.value = 0.22;
  noise.connect(g); g.connect(audioCtx.destination);
  noise.start();
  noise.stop(audioCtx.currentTime + 0.22);
}

// --- Explosion parameters (fixed as richiesto) ---
const COLOR_MAX_RADIUS = { black: 50, red: 100, blue: 150 };
const EXPANSION_PER_FRAME = 5; // px per frame (come deciso)

// Penalty per esplosione a catena (successive alla prima)
const CHAIN_PENALTY = { black: 10, red: 15, blue: 20 };

// --- Game parameters (tweak here for balance) ---
function requiredForLevel(L){ return state.R0 + state.deltaR * (L - 1); }
function spawnIntervalForLevel(L){ return Math.max(350, 900 - (L-1)*60); } // ms
function bombLifetimeForLevel(L){ return Math.max(1200, 4200 - (L-1)*300); } // ms
function spawnChanceColorForLevel(L){
  // returns probabilities for [black, blue, red]
  // as level grows, probability of blue/red increases
  const red = Math.min(0.25, 0.03 + 0.02 * (L-1));
  const blue = Math.min(0.45, 0.2 + 0.05 * (L-1));
  const black = 1 - red - blue;
  return [black, blue, red];
}
function valueForColorAndLevel(color, L){
  if(color === 'black') return Math.random() < 0.85 ? 1 : 2;
  if(color === 'blue') return Math.random() < 0.65 ? 2 : 3;
  return Math.random() < 0.6 ? 3 : 4;
}
function multiplierForColor(color){
  if(color === 'black') return 1.0;
  if(color === 'blue') return 1.5;
  if(color === 'red') return 2.0;
  return 1.0;
}

// --- Helpers for positioning (avoid overlaps) ---
function getPlayAreaRect(){ return playArea.getBoundingClientRect(); }

function randomPosition(size){
  const pad = 8;
  const rect = getPlayAreaRect();
  const w = Math.max(260, rect.width);
  const h = Math.max(180, rect.height - 80); // leave hud
  const x = Math.floor(Math.random() * (w - size - pad*2)) + pad;
  const y = Math.floor(Math.random() * (h - size - pad*2)) + pad;
  return {x,y};
}

function isTooClose(x,y,size){
  for(const b of state.bombs.values()){
    const dx = b.x - x;
    const dy = b.y - y;
    const dist = Math.hypot(dx,dy);
    if(dist < size * 0.9 + (b.size || 72)*0.9) return true;
  }
  return false;
}

// --- DOM creation helpers ---
function createBombElement(b){
  const el = document.createElement('div');
  el.className = `bomb ${b.color}`;
  el.style.width = `${b.size}px`;
  el.style.height = `${b.size}px`;
  el.style.left = `${b.x}px`;
  el.style.top = `${b.y}px`;
  el.dataset.id = b.id;
  el.innerHTML = `<div class="value">${b.currentValue}</div>`;
  // attach click/touch handler
  el.addEventListener('pointerdown', onBombPointerDown);
  return el;
}

function createExplosionVisual(x,y){
  const e = document.createElement('div');
  e.className = 'explosion';
  e.style.left = `${x}px`;
  e.style.top = `${y}px`;
  playArea.appendChild(e);
  setTimeout(()=>{ e.remove(); }, 520);
}

// explosion wave DOM creator (expanding circle)
function createExplosionWaveDOM(x,y,initialRadius=0){
  const el = document.createElement('div');
  el.className = 'explosion-wave';
  // center-based positioning (translate(-50%,-50%) in CSS)
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.width = `${initialRadius*2}px`;
  el.style.height = `${initialRadius*2}px`;
  playArea.appendChild(el);
  return el;
}

// bonus element
function createBonusElement(type, x, y){
  const el = document.createElement('div');
  el.className = 'bonus';
  el.dataset.type = type;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.innerText = bonusLabel(type);
  el.addEventListener('pointerdown', onBonusPick);
  playArea.appendChild(el);
  // auto-remove after some time
  setTimeout(()=>{ if(el.parentElement) el.remove(); }, 9000);
  return el;
}
function bonusLabel(type){
  switch(type){
    case 'time': return '+T';
    case 'score': return '+P';
    case 'mult': return '×';
    case 'shield': return 'S';
    case 'freeze': return '❄';
    default: return '?';
  }
}

// --- Bomb management ---
function spawnBomb(){
  const id = uid();
  const size = 72;
  let pos = randomPosition(size);
  let attempts = 0;
  while(isTooClose(pos.x,pos.y,size) && attempts < 25){
    pos = randomPosition(size);
    attempts++;
  }
  const L = state.level;
  const [pBlack, pBlue, pRed] = spawnChanceColorForLevel(L);
  const r = Math.random();
  const color = r < pBlack ? 'black' : (r < pBlack + pBlue ? 'blue' : 'red');
  const value = valueForColorAndLevel(color, L);
  const multiplier = multiplierForColor(color);
  const lifetime = bombLifetimeForLevel(L);
  const createdAt = Date.now();

  const bomb = {
    id, x: pos.x, y: pos.y, size, color, originalValue: value,
    currentValue: value, multiplier, lifetime, createdAt, exploded:false,
    willExplode:false, // new: flag to avoid double-queueing
    dom: null, timerHandle: null
  };

  const el = createBombElement(bomb);
  playArea.appendChild(el);
  bomb.dom = el;
  state.bombs.set(id, bomb);

  // schedule explosion
  scheduleBombTimer(bomb);

  return bomb;
}

function scheduleBombTimer(bomb){
  if(bomb.timerHandle) clearTimeout(bomb.timerHandle);
  const now = Date.now();
  const left = Math.max(0, bomb.lifetime - (now - bomb.createdAt));
  // if freeze active, postpone timer until freeze ends
  const fire = () => {
    if(!state.bombs.has(bomb.id)) return;
    if(Date.now() < state.freezeUntil){
      // postpone when freeze ends
      const remaining = Math.max(50, bomb.lifetime - (Date.now() - bomb.createdAt));
      bomb.timerHandle = setTimeout(fire, remaining + 50);
      return;
    }
    triggerExplosion(bomb.id); // non-chained (root)
  };
  bomb.timerHandle = setTimeout(fire, left);
}

function onBombPointerDown(e){
  // synth sound requires audio context resume on mobile after user gesture
  if(audioCtx.state === 'suspended') audioCtx.resume();

  const id = this.dataset.id;
  const bomb = state.bombs.get(Number(id));
  if(!bomb) return;
  // If bomb already exploded or in disarm, ignore
  if(bomb.exploded || bomb.currentValue <= 0) return;

  // decrement
  bomb.currentValue -= 1;
  // update DOM
  const valEl = bomb.dom.querySelector('.value');
  valEl.textContent = bomb.currentValue;

  playClickSound();

  // if reached 0 -> disarm
  if(bomb.currentValue <= 0){
    disarmBomb(bomb.id);
  } else {
    // slight press animation
    bomb.dom.style.transform = 'scale(0.98)';
    setTimeout(()=>{ if(bomb.dom) bomb.dom.style.transform = ''; }, 90);
  }
}

function disarmBomb(id){
  const bomb = state.bombs.get(Number(id));
  if(!bomb) return;
  // cancel explosion timer
  if(bomb.timerHandle) clearTimeout(bomb.timerHandle);
  bomb.currentValue = 0;
  // award points: use originalValue * multiplier
  const pts = Math.round(bomb.originalValue * bomb.multiplier);
  state.score += pts;
  updateScoreUI();
  // increment disarmed
  state.disarmed += 1;
  updateDisarmedUI();

  // visual shrink animation
  bomb.dom.classList.add('disarm');
  // remove after animation
  setTimeout(()=>{
    // spawn bonus occasionally
    const dropRate = 0.28; // 28% chance to drop a bonus
    if(Math.random() < dropRate){
      const types = ['time','score','mult','shield','freeze'];
      const pick = types[Math.floor(Math.random()*types.length)];
      createBonusElement(pick, bomb.x + bomb.size/4, bomb.y + bomb.size/4);
    }
    // cleanup
    if(bomb.dom && bomb.dom.parentElement) bomb.dom.remove();
    state.bombs.delete(bomb.id);
  }, 320);
}

/*
  triggerExplosion(id, chained = false)
  - Gestisce l'esplosione di una bomba singola (timer o collisione).
  - Se chained===false => è l'esplosione "radice" (prima della catena).
  - Se chained===true  => è un'esplosione derivata dalla catena.
*/
function triggerExplosion(id, chained = false){
  const bomb = state.bombs.get(Number(id));
  if(!bomb) return;
  if(bomb.exploded) return;
  bomb.exploded = true;

  // capture color before cleanup
  const color = bomb.color || 'black';

  // cancel timer and remove DOM
  if(bomb.timerHandle) clearTimeout(bomb.timerHandle);
  if(bomb.dom && bomb.dom.parentElement) bomb.dom.remove();

  // center coordinates (center point)
  const cx = bomb.x + bomb.size/2;
  const cy = bomb.y + bomb.size/2;

  // small visual pop (existing short effect)
  createExplosionVisual(cx, cy);

  // sound
  if(audioCtx.state === 'suspended') audioCtx.resume().then(()=>playExplosionSound()).catch(()=>playExplosionSound());
  else playExplosionSound();

  // apply penalty:
  if(state.shieldActive){
    // shield consumes the penalty for this explosion (both root and chained)
    state.shieldActive = false;
    updateBonusesUI();
  } else {
    if(!chained){
      // root explosion: halve the score (as before)
      state.score = Math.floor(state.score / 2);
      updateScoreUI();
    } else {
      // chained explosion: subtract fixed penalty depending on color
      const pen = CHAIN_PENALTY[color] || 10;
      state.score = Math.max(0, state.score - pen);
      updateScoreUI();
    }
  }

  // create expanding explosion wave (this handles chain collisions)
  const maxR = COLOR_MAX_RADIUS[color] || 50;
  createExplosionWave(cx, cy, maxR);

  // remove bomb from collection so future collision checks don't include it
  state.bombs.delete(bomb.id);
}

/* createExplosionWave(x,y,maxRadius)
   crea l'oggetto esplosione (DOM + stato) e lo aggiunge a state.explosions
*/
function createExplosionWave(x,y,maxRadius){
  const dom = createExplosionWaveDOM(x,y,0);
  const expl = {
    x, y,
    radius: 0,
    maxRadius,
    expansionSpeed: EXPANSION_PER_FRAME,
    dom,
    active: true
  };
  state.explosions.push(expl);
}

/* updateExplosions()
   - chiamata per frame: aggiorna il raggio, aggiorna DOM,
     verifica collisioni con bombe e accoda esplosioni a catena.
*/
function updateExplosions(){
  if(state.explosions.length === 0) return;

  const toTriggerNext = new Set(); // bomb ids da esplodere al "next tick"
  // Aggiorna ogni esplosione
  for(const expl of state.explosions){
    if(!expl.active) continue;
    expl.radius += expl.expansionSpeed;
    // update DOM size (width/height centered via translate(-50%,-50%))
    const d = Math.max(0, expl.radius * 2);
    if(expl.dom){
      expl.dom.style.width = `${d}px`;
      expl.dom.style.height = `${d}px`;
      // optional: fade out as it approaches max
      const t = Math.max(0, 1 - expl.radius / expl.maxRadius);
      expl.dom.style.opacity = `${0.45 * t + 0.15}`;
      // border thickness can scale optionally
      // expl.dom.style.borderWidth = `${Math.max(1, (1.5 * t))}px`;
    }

    // collision detection with bombs (simple circle-to-center test)
    for(const b of state.bombs.values()){
      if(b.exploded || b.willExplode) continue;
      const bx = b.x + b.size/2;
      const by = b.y + b.size/2;
      const dx = bx - expl.x;
      const dy = by - expl.y;
      const dist = Math.hypot(dx, dy);
      const bombRadius = b.size / 2;
      if(dist <= expl.radius + bombRadius){
        // schedule this bomb to explode next tick (avoid immediate recursion)
        b.willExplode = true;
        toTriggerNext.add(b.id);
      }
    }

    // check end of explosion
    if(expl.radius >= expl.maxRadius){
      expl.active = false;
      if(expl.dom && expl.dom.parentElement) expl.dom.remove();
    }
  }

  // rimuovi esplosioni non attive dall'array (pulizia)
  state.explosions = state.explosions.filter(e => e.active);

  // trigger queued bombs on next macrotask (effectively next frame)
  if(toTriggerNext.size > 0){
    // small timeout 0 to ensure we finish DOM updates in this frame
    setTimeout(()=>{
      for(const bid of toTriggerNext){
        const b = state.bombs.get(bid);
        if(!b) continue;
        // clear willExplode flag now (triggerExplosion will delete the bomb)
        b.willExplode = false;
        // *** Important: these are chained explosions ***
        triggerExplosion(bid, true);
      }
    }, 0);
  }
}

// --- Bonuses ---
function onBonusPick(e){
  const el = this;
  const type = el.dataset.type;
  // pick up
  applyBonus(type);
  el.remove();
}

function applyBonus(type){
  switch(type){
    case 'time':
      // add +6s
      const added = 6;
      state.levelEndAt += added * 1000;
      break;
    case 'score':
      state.score += 12;
      updateScoreUI();
      break;
    case 'mult':
      // temporary multiplier: add 0.3× for next 8 seconds
      state.runningMult = (state.runningMult || 1) + 0.3;
      setTimeout(()=>{ state.runningMult = Math.max(1, (state.runningMult || 1) - 0.3); }, 8000);
      break;
    case 'shield':
      state.shieldActive = true;
      updateBonusesUI();
      break;
    case 'freeze':
      state.freezeUntil = Date.now() + 3500;
      // postpone existing bombs timers by freezing mechanism
      for(const b of state.bombs.values()){
        scheduleBombTimer(b);
      }
      break;
    default:
      break;
  }
  // small feedback
  flashHUD();
}

function updateBonusesUI(){
  bonusesBar.innerHTML = '';
  if(state.shieldActive){
    const s = document.createElement('div');
    s.className = 'bonus';
    s.style.width = '36px';
    s.style.height = '36px';
    s.style.display = 'inline-flex';
    s.style.alignItems = 'center';
    s.style.justifyContent = 'center';
    s.style.marginLeft = '8px';
    s.textContent = 'S';
    bonusesBar.appendChild(s);
  }
  // future: show running mult icons etc.
}

function flashHUD(){
  const el = document.getElementById('hud');
  el.style.transition = 'box-shadow 160ms';
  el.style.boxShadow = '0 0 18px rgba(255,200,60,0.12)';
  setTimeout(()=>{ el.style.boxShadow = ''; }, 180);
}

// --- level / timer management ---
function updateScoreUI(){
  scoreEl.textContent = String(state.score);
}
function updateDisarmedUI(){
  disarmedEl.textContent = String(state.disarmed);
}
function updateRequiredUI(){
  requiredEl.textContent = String(state.required);
}
function updateLevelUI(){
  levelEl.textContent = String(state.level);
}

function startLevel(L = 1){
  resetLevelState(L);
  state.running = true;
  updateScoreUI(); updateDisarmedUI(); updateRequiredUI(); updateLevelUI();
  overlay.classList.add('hidden');

  // spawn loop
  const spawnMs = spawnIntervalForLevel(L);
  state.spawnIntervalHandle = setInterval(()=>{
    // limit bombs on screen based on available size and level
    const maxOnScreen = Math.min(12 + L*2, 28);
    if(state.bombs.size < maxOnScreen && Date.now() >= state.freezeUntil){
      spawnBomb();
    }
  }, Math.max(220, spawnMs));

  // level timer
  const now = Date.now();
  state.levelEndAt = now + state.timePerLevel * 1000;
  timerTick(); // update immediately
  state.levelTimerHandle = setInterval(timerTick, 200);
}

function timerTick(){
  const remainingMs = Math.max(0, state.levelEndAt - Date.now());
  const remSec = Math.ceil(remainingMs / 1000);
  timerEl.textContent = String(remSec);
  // if ended
  if(remainingMs <= 0){
    finishLevel();
  }
}

function finishLevel(){
  // stop loops
  if(state.spawnIntervalHandle) clearInterval(state.spawnIntervalHandle);
  if(state.levelTimerHandle) clearInterval(state.levelTimerHandle);
  state.spawnIntervalHandle = null;
  state.levelTimerHandle = null;
  state.running = false;

  // evaluate
  const success = state.disarmed >= state.required;
  // cleanup remaining bombs visuals
  for(const b of state.bombs.values()){
    if(b.timerHandle) clearTimeout(b.timerHandle);
    if(b.dom && b.dom.parentElement) b.dom.remove();
  }
  state.bombs.clear();

  // cleanup explosions
  for(const ex of state.explosions){
    if(ex.dom && ex.dom.parentElement) ex.dom.remove();
  }
  state.explosions = [];

  showOverlay(success);
}

function resetLevelState(L){
  // clear existing timers/DOM
  if(state.spawnIntervalHandle) clearInterval(state.spawnIntervalHandle);
  if(state.levelTimerHandle) clearInterval(state.levelTimerHandle);
  for(const b of state.bombs.values()){
    if(b.timerHandle) clearTimeout(b.timerHandle);
    if(b.dom && b.dom.parentElement) b.dom.remove();
  }
  state.bombs.clear();

  // clear explosions
  for(const ex of state.explosions){
    if(ex.dom && ex.dom.parentElement) ex.dom.remove();
  }
  state.explosions = [];

  state.level = L;
  state.score = state.score || 0; // keep total score (or reset if desired)
  state.disarmed = 0;
  state.required = requiredForLevel(L);
  state.shieldActive = false;
  state.freezeUntil = 0;
  state.runningMult = 1;
}

// --- overlay UI ---
function showOverlay(success){
  overlay.classList.remove('hidden');
  overlayTitle.textContent = success ? 'Livello superato!' : 'Game Over';
  overlayStats.innerHTML = `
    Livello ${state.level} — Bombe disinnescate: ${state.disarmed}/${state.required}<br>
    Punteggio: ${state.score}
  `;
  if(success){
    btnNext.classList.remove('hidden');
    btnRestart.classList.add('hidden');
  } else {
    btnNext.classList.add('hidden');
    btnRestart.classList.remove('hidden');
  }
}

// --- controls ---
btnRestart.addEventListener('click', ()=>{
  overlay.classList.add('hidden');
  startLevel(state.level);
});

btnNext.addEventListener('click', ()=>{
  overlay.classList.add('hidden');
  startLevel(state.level + 1);
});

// --- main animation loop (per-frame updates) ---
let lastRAF = 0;
function gameLoop(ts){
  // update explosions (and chain logic)
  updateExplosions();

  // could add other per-frame visual updates here in futuro

  lastRAF = ts;
  requestAnimationFrame(gameLoop);
}

// --- init & small UI binding ---
function init(){
  // initial required
  state.required = requiredForLevel(state.level);
  updateRequiredUI();
  updateLevelUI();
  // Start on first user gesture because of audio policy
  const startBtn = document.createElement('button');
  startBtn.textContent = 'Avvia (clicca/tocca per iniziare)';
  startBtn.style.position = 'absolute';
  startBtn.style.left = '50%';
  startBtn.style.top = '50%';
  startBtn.style.transform = 'translate(-50%,-50%)';
  startBtn.style.zIndex = 9999;
  startBtn.style.padding = '12px 16px';
  startBtn.style.borderRadius = '10px';
  playArea.appendChild(startBtn);

  startBtn.addEventListener('click', async () => {
    // resume audio context (mobile)
    if(audioCtx.state === 'suspended') await audioCtx.resume();
    startBtn.remove();
    startLevel(1);
    // start RAF loop once at game start (keeps running until page unload)
    requestAnimationFrame(gameLoop);
  });
}

init();
// --- Sound synthesis (very small, no files) ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playClickSound(){
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = 'sine';
  o.frequency.value = 880;
  g.gain.value = 0.08;
  o.connect(g); g.connect(audioCtx.destination);
  o.start();
  g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
  o.stop(audioCtx.currentTime + 0.13);
}

function playExplosionSound(){
  // short noise burst
  const bufferSize = audioCtx.sampleRate * 0.3;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i=0;i<bufferSize;i++){
    const t = i / bufferSize;
    data[i] = (Math.random()*2-1) * (1 - t) * Math.exp(-3*t);
  }
  const noise = audioCtx.createBufferSource();
  noise.buffer = buffer;
  const g = audioCtx.createGain();
  g.gain.value = 0.25;
  noise.connect(g); g.connect(audioCtx.destination);
  noise.start();
  noise.stop(audioCtx.currentTime + 0.28);
}

// --- Game parameters (tweak here for balance) ---
function requiredForLevel(L){ return state.R0 + state.deltaR * (L - 1); }
function spawnIntervalForLevel(L){ return Math.max(350, 900 - (L-1)*60); } // ms
function bombLifetimeForLevel(L){ return Math.max(1200, 4200 - (L-1)*300); } // ms
function spawnChanceColorForLevel(L){
  // returns probabilities for [black, blue, red]
  // as level grows, probability of blue/red increases
  const red = Math.min(0.25, 0.03 + 0.02 * (L-1));
  const blue = Math.min(0.45, 0.2 + 0.05 * (L-1));
  const black = 1 - red - blue;
  return [black, blue, red];
}
function valueForColorAndLevel(color, L){
  // value = how many taps required; depends on level and color
  // black tends to be 1, blue 1–2, red 2–4
  if(color === 'black') return Math.random() < 0.85 ? 1 : 2;
  if(color === 'blue') return Math.random() < 0.65 ? 2 : 3;
  return Math.random() < 0.6 ? 3 : 4;
}
function multiplierForColor(color){
  if(color === 'black') return 1.0;
  if(color === 'blue') return 1.5;
  if(color === 'red') return 2.0;
  return 1.0;
}

// --- Helpers for positioning (avoid overlaps) ---
function getPlayAreaRect(){ return playArea.getBoundingClientRect(); }

function randomPosition(size){
  const pad = 8;
  const rect = getPlayAreaRect();
  const w = Math.max(260, rect.width);
  const h = Math.max(180, rect.height - 80); // leave hud
  const x = Math.floor(Math.random() * (w - size - pad*2)) + pad;
  const y = Math.floor(Math.random() * (h - size - pad*2)) + pad;
  return {x,y};
}

function isTooClose(x,y,size){
  for(const b of state.bombs.values()){
    const dx = b.x - x;
    const dy = b.y - y;
    const dist = Math.hypot(dx,dy);
    if(dist < size * 0.9 + (b.size || 72)*0.9) return true;
  }
  return false;
}

// --- DOM creation helpers ---
function createBombElement(b){
  const el = document.createElement('div');
  el.className = `bomb ${b.color}`;
  el.style.width = `${b.size}px`;
  el.style.height = `${b.size}px`;
  el.style.left = `${b.x}px`;
  el.style.top = `${b.y}px`;
  el.dataset.id = b.id;
  el.innerHTML = `<div class="value">${b.currentValue}</div>`;
  // attach click/touch handler
  el.addEventListener('pointerdown', onBombPointerDown);
  return el;
}

function createExplosionVisual(x,y){
  const e = document.createElement('div');
  e.className = 'explosion';
  e.style.left = `${x}px`;
  e.style.top = `${y}px`;
  playArea.appendChild(e);
  setTimeout(()=>{ e.remove(); }, 520);
}

// bonus element
function createBonusElement(type, x, y){
  const el = document.createElement('div');
  el.className = 'bonus';
  el.dataset.type = type;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.innerText = bonusLabel(type);
  el.addEventListener('pointerdown', onBonusPick);
  playArea.appendChild(el);
  // auto-remove after some time
  setTimeout(()=>{ if(el.parentElement) el.remove(); }, 9000);
  return el;
}
function bonusLabel(type){
  switch(type){
    case 'time': return '+T';
    case 'score': return '+P';
    case 'mult': return '×';
    case 'shield': return 'S';
    case 'freeze': return '❄';
    default: return '?';
  }
}

// --- Bomb management ---
function spawnBomb(){
  const id = uid();
  const size = 72;
  let pos = randomPosition(size);
  let attempts = 0;
  while(isTooClose(pos.x,pos.y,size) && attempts < 25){
    pos = randomPosition(size);
    attempts++;
  }
  const L = state.level;
  const [pBlack, pBlue, pRed] = spawnChanceColorForLevel(L);
  const r = Math.random();
  const color = r < pBlack ? 'black' : (r < pBlack + pBlue ? 'blue' : 'red');
  const value = valueForColorAndLevel(color, L);
  const multiplier = multiplierForColor(color);
  const lifetime = bombLifetimeForLevel(L);
  const createdAt = Date.now();

  const bomb = {
    id, x: pos.x, y: pos.y, size, color, originalValue: value,
    currentValue: value, multiplier, lifetime, createdAt, exploded:false,
    dom: null, timerHandle: null
  };

  const el = createBombElement(bomb);
  playArea.appendChild(el);
  bomb.dom = el;
  state.bombs.set(id, bomb);

  // schedule explosion
  scheduleBombTimer(bomb);

  return bomb;
}

function scheduleBombTimer(bomb){
  if(bomb.timerHandle) clearTimeout(bomb.timerHandle);
  const now = Date.now();
  const left = Math.max(0, bomb.lifetime - (now - bomb.createdAt));
  // if freeze active, postpone timer until freeze ends
  const fire = () => {
    if(!state.bombs.has(bomb.id)) return;
    if(Date.now() < state.freezeUntil){
      // postpone when freeze ends
      const remaining = Math.max(50, bomb.lifetime - (Date.now() - bomb.createdAt));
      bomb.timerHandle = setTimeout(fire, remaining + 50);
      return;
    }
    triggerExplosion(bomb.id);
  };
  bomb.timerHandle = setTimeout(fire, left);
}

function onBombPointerDown(e){
  // synth sound requires audio context resume on mobile after user gesture
  if(audioCtx.state === 'suspended') audioCtx.resume();

  const id = this.dataset.id;
  const bomb = state.bombs.get(Number(id));
  if(!bomb) return;
  // If bomb already exploded or in disarm, ignore
  if(bomb.exploded || bomb.currentValue <= 0) return;

  // decrement
  bomb.currentValue -= 1;
  // update DOM
  const valEl = bomb.dom.querySelector('.value');
  valEl.textContent = bomb.currentValue;

  playClickSound();

  // if reached 0 -> disarm
  if(bomb.currentValue <= 0){
    disarmBomb(bomb.id);
  } else {
    // slight press animation
    bomb.dom.style.transform = 'scale(0.98)';
    setTimeout(()=>{ if(bomb.dom) bomb.dom.style.transform = ''; }, 90);
  }
}

function disarmBomb(id){
  const bomb = state.bombs.get(Number(id));
  if(!bomb) return;
  // cancel explosion timer
  if(bomb.timerHandle) clearTimeout(bomb.timerHandle);
  bomb.currentValue = 0;
  // award points: use originalValue * multiplier
  const pts = Math.round(bomb.originalValue * bomb.multiplier);
  state.score += pts;
  updateScoreUI();
  // increment disarmed
  state.disarmed += 1;
  updateDisarmedUI();

  // visual shrink animation
  bomb.dom.classList.add('disarm');
  // remove after animation
  setTimeout(()=>{
    // spawn bonus occasionally
    const dropRate = 0.28; // 28% chance to drop a bonus
    if(Math.random() < dropRate){
      const types = ['time','score','mult','shield','freeze'];
      const pick = types[Math.floor(Math.random()*types.length)];
      createBonusElement(pick, bomb.x + bomb.size/4, bomb.y + bomb.size/4);
    }
    // cleanup
    if(bomb.dom && bomb.dom.parentElement) bomb.dom.remove();
    state.bombs.delete(bomb.id);
  }, 320);
}

function triggerExplosion(id){
  const bomb = state.bombs.get(Number(id));
  if(!bomb) return;
  if(bomb.exploded) return;
  bomb.exploded = true;
  // visual
  createExplosionVisual(bomb.x + bomb.size/2, bomb.y + bomb.size/2);
  // sound
  playExplosionSound();

  // apply penalty: shield prevents penalty once
  if(state.shieldActive){
    state.shieldActive = false;
    updateBonusesUI();
  } else {
    // halve the score
    state.score = Math.floor(state.score / 2);
    updateScoreUI();
  }

  // cleanup DOM
  if(bomb.dom && bomb.dom.parentElement) bomb.dom.remove();
  if(bomb.timerHandle) clearTimeout(bomb.timerHandle);
  state.bombs.delete(bomb.id);
}

// --- Bonuses ---
function onBonusPick(e){
  const el = this;
  const type = el.dataset.type;
  // pick up
  applyBonus(type);
  el.remove();
}

function applyBonus(type){
  switch(type){
    case 'time':
      // add +6s
      const added = 6;
      state.levelEndAt += added * 1000;
      break;
    case 'score':
      state.score += 12;
      updateScoreUI();
      break;
    case 'mult':
      // temporary multiplier: add 0.3× for next 8 seconds
      state.runningMult = (state.runningMult || 1) + 0.3;
      setTimeout(()=>{ state.runningMult = Math.max(1, (state.runningMult || 1) - 0.3); }, 8000);
      break;
    case 'shield':
      state.shieldActive = true;
      updateBonusesUI();
      break;
    case 'freeze':
      state.freezeUntil = Date.now() + 3500;
      // postpone existing bombs timers by freezing mechanism
      for(const b of state.bombs.values()){
        scheduleBombTimer(b);
      }
      break;
    default:
      break;
  }
  // small feedback
  flashHUD();
}

function updateBonusesUI(){
  bonusesBar.innerHTML = '';
  if(state.shieldActive){
    const s = document.createElement('div');
    s.className = 'bonus';
    s.style.width = '36px';
    s.style.height = '36px';
    s.style.display = 'inline-flex';
    s.style.alignItems = 'center';
    s.style.justifyContent = 'center';
    s.style.marginLeft = '8px';
    s.textContent = 'S';
    bonusesBar.appendChild(s);
  }
  // future: show running mult icons etc.
}

function flashHUD(){
  const el = document.getElementById('hud');
  el.style.transition = 'box-shadow 160ms';
  el.style.boxShadow = '0 0 18px rgba(255,200,60,0.12)';
  setTimeout(()=>{ el.style.boxShadow = ''; }, 180);
}

// --- level / timer management ---
function updateScoreUI(){
  scoreEl.textContent = String(state.score);
}
function updateDisarmedUI(){
  disarmedEl.textContent = String(state.disarmed);
}
function updateRequiredUI(){
  requiredEl.textContent = String(state.required);
}
function updateLevelUI(){
  levelEl.textContent = String(state.level);
}

function startLevel(L = 1){
  resetLevelState(L);
  state.running = true;
  updateScoreUI(); updateDisarmedUI(); updateRequiredUI(); updateLevelUI();
  overlay.classList.add('hidden');

  // spawn loop
  const spawnMs = spawnIntervalForLevel(L);
  state.spawnIntervalHandle = setInterval(()=>{
    // limit bombs on screen based on available size and level
    const maxOnScreen = Math.min(12 + L*2, 28);
    if(state.bombs.size < maxOnScreen && Date.now() >= state.freezeUntil){
      spawnBomb();
    }
  }, Math.max(220, spawnMs));

  // level timer
  const now = Date.now();
  state.levelEndAt = now + state.timePerLevel * 1000;
  timerTick(); // update immediately
  state.levelTimerHandle = setInterval(timerTick, 200);
}

function timerTick(){
  const remainingMs = Math.max(0, state.levelEndAt - Date.now());
  const remSec = Math.ceil(remainingMs / 1000);
  timerEl.textContent = String(remSec);
  // if ended
  if(remainingMs <= 0){
    finishLevel();
  }
}

function finishLevel(){
  // stop loops
  if(state.spawnIntervalHandle) clearInterval(state.spawnIntervalHandle);
  if(state.levelTimerHandle) clearInterval(state.levelTimerHandle);
  state.spawnIntervalHandle = null;
  state.levelTimerHandle = null;
  state.running = false;

  // evaluate
  const success = state.disarmed >= state.required;
  // cleanup remaining bombs visuals
  for(const b of state.bombs.values()){
    if(b.timerHandle) clearTimeout(b.timerHandle);
    if(b.dom && b.dom.parentElement) b.dom.remove();
  }
  state.bombs.clear();

  showOverlay(success);
}

function resetLevelState(L){
  // clear existing timers/DOM
  if(state.spawnIntervalHandle) clearInterval(state.spawnIntervalHandle);
  if(state.levelTimerHandle) clearInterval(state.levelTimerHandle);
  for(const b of state.bombs.values()){
    if(b.timerHandle) clearTimeout(b.timerHandle);
    if(b.dom && b.dom.parentElement) b.dom.remove();
  }
  state.bombs.clear();

  state.level = L;
  state.score = state.score || 0; // keep total score (or reset if desired)
  state.disarmed = 0;
  state.required = requiredForLevel(L);
  state.shieldActive = false;
  state.freezeUntil = 0;
  state.runningMult = 1;
}

// --- overlay UI ---
function showOverlay(success){
  overlay.classList.remove('hidden');
  overlayTitle.textContent = success ? 'Livello superato!' : 'Game Over';
  overlayStats.innerHTML = `
    Livello ${state.level} — Bombe disinnescate: ${state.disarmed}/${state.required}<br>
    Punteggio: ${state.score}
  `;
  if(success){
    btnNext.classList.remove('hidden');
    btnRestart.classList.add('hidden');
  } else {
    btnNext.classList.add('hidden');
    btnRestart.classList.remove('hidden');
  }
}

// --- controls ---
btnRestart.addEventListener('click', ()=>{
  overlay.classList.add('hidden');
  startLevel(state.level);
});

btnNext.addEventListener('click', ()=>{
  overlay.classList.add('hidden');
  startLevel(state.level + 1);
});

// --- init & small UI binding ---
function init(){
  // initial required
  state.required = requiredForLevel(state.level);
  updateRequiredUI();
  updateLevelUI();
  // Start on first user gesture because of audio policy
  const startBtn = document.createElement('button');
  startBtn.textContent = 'Avvia (clicca/tocca per iniziare)';
  startBtn.style.position = 'absolute';
  startBtn.style.left = '50%';
  startBtn.style.top = '50%';
  startBtn.style.transform = 'translate(-50%,-50%)';
  startBtn.style.zIndex = 9999;
  startBtn.style.padding = '12px 16px';
  startBtn.style.borderRadius = '10px';
  playArea.appendChild(startBtn);

  startBtn.addEventListener('click', async () => {
    // resume audio context (mobile)
    if(audioCtx.state === 'suspended') await audioCtx.resume();
    startBtn.remove();
    startLevel(1);
  });
}


// ---------------- SAFE DEBUG OVERLAY (mobile-friendly) ----------------
(function(){
  function createOverlay(){
    const existing = document.getElementById('__game_debug_overlay');
    if(existing) return existing;
    const dbg = document.createElement('div');
    dbg.id = '__game_debug_overlay';
    dbg.style.position = 'fixed';
    dbg.style.right = '8px';
    dbg.style.bottom = '8px';
    dbg.style.zIndex = '99999';
    dbg.style.maxWidth = '42vw';
    dbg.style.maxHeight = '48vh';
    dbg.style.overflow = 'auto';
    dbg.style.fontSize = '11px';
    dbg.style.background = 'rgba(0,0,0,0.55)';
    dbg.style.color = '#fff';
    dbg.style.padding = '8px';
    dbg.style.borderRadius = '8px';
    dbg.style.backdropFilter = 'blur(4px)';
    dbg.style.boxShadow = '0 6px 18px rgba(0,0,0,0.6)';
    dbg.style.lineHeight = '1.2';
    dbg.style.fontFamily = 'monospace';
    dbg.innerHTML = '<strong style="display:block;margin-bottom:6px">DBG</strong>';
    document.body.appendChild(dbg);
    return dbg;
  }

  function safeInstall(){
    try{
      const dbg = createOverlay();

      // helper per aggiungere messaggi
      window.debugLog = function(txt){
        try{
          const p = document.createElement('div');
          p.textContent = `${(new Date()).toLocaleTimeString()} · ${txt}`;
          dbg.appendChild(p);
          dbg.scrollTop = dbg.scrollHeight;
          if(dbg.children.length > 90) dbg.removeChild(dbg.children[1]);
        }catch(e){ console.warn('debugLog error', e); }
      };

      // esposizione helpers non invasiva (se le variabili esistono)
      try{ if(typeof state !== 'undefined') window._GAME_STATE = state; }catch(e){}
      try{ if(typeof spawnBomb !== 'undefined') window._spawnBomb = spawnBomb; }catch(e){}

      window.debugLog('DEBUG overlay installed. Attendi spawn / esplosioni.');

      // Polling per patchare le funzioni solo quando esistono, senza lanciare errori
      const start = Date.now();
      const maxWait = 2000; // ms
      const iv = setInterval(()=>{
        try{
          const foundTrigger = (typeof triggerExplosion === 'function');
          const foundUpdate = (typeof updateExplosions === 'function');

          if(foundTrigger || foundUpdate){
            // patch solo le funzioni trovate
            if(foundTrigger){
              try{
                const _origTrigger = triggerExplosion;
                triggerExplosion = function(id, chained = false){
                  window.debugLog(`triggerExplosion id=${id} chained=${chained}`);
                  return _origTrigger(id, chained);
                };
                window.debugLog('triggerExplosion wrapped');
              }catch(e){ window.debugLog('wrap triggerExplosion failed'); }
            }

            if(foundUpdate){
              try{
                const _origUpdate = updateExplosions;
                updateExplosions = function(){
                  const before = (typeof state !== 'undefined' && state.explosions) ? state.explosions.length : 0;
                  _origUpdate();
                  const after = (typeof state !== 'undefined' && state.explosions) ? state.explosions.length : 0;
                  if(before !== after) window.debugLog(`explosions ${before} → ${after}`);
                };
                window.debugLog('updateExplosions wrapped');
              }catch(e){ window.debugLog('wrap updateExplosions failed'); }
            }

            clearInterval(iv);
          } else if(Date.now() - start > maxWait){
            window.debugLog('patch timeout: funzioni non trovate (continua senza patch)');
            clearInterval(iv);
          }
        }catch(err){
          console.warn('DBG poll error', err);
          clearInterval(iv);
        }
      }, 100);
    }catch(err){
      console.error('SAFE DEBUG INSTALL ERROR', err);
      // non fare nulla: non interrompere il gioco
    }
  }

  if(document.readyState === 'complete' || document.readyState === 'interactive'){
    safeInstall();
  } else {
    document.addEventListener('DOMContentLoaded', safeInstall);
  }
})();
// ---------------- end SAFE DEBUG OVERLAY ----------------


init();
