// --- DOM refs ---
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

// --- State ---
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

// --- Audio ---
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

// --- Explosion params ---
const COLOR_MAX_RADIUS = { black: 50, red: 100, blue: 150 };
const EXPANSION_PER_FRAME = 5;
const CHAIN_PENALTY = { black: 10, red: 15, blue: 20 };

// --- Game param helpers ---
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

// --- Positioning helpers ---
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

// --- DOM helpers ---
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

// --- Bomb logic ---
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

// --- bonuses ---
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

// --- UI updates ---
function updateScoreUI(){ scoreEl.textContent = String(state.score); }
function updateDisarmedUI(){ disarmedEl.textContent = String(state.disarmed); }
function updateRequiredUI(){ requiredEl.textContent = String(state.required); }
function updateLevelUI(){ levelEl.textContent = String(state.level); }

// --- Level management ---
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

// --- Overlay / UI controls ---
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

// --- Animation loop for explosions ---
function gameLoop(){
  updateExplosions();
  requestAnimationFrame(gameLoop);
}

// --- Expose functions globally for fallback button ---
window.startLevel = startLevel;
window.gameLoop = gameLoop;
window.audioCtx = audioCtx;

// --- Initialize game state ---
document.addEventListener('DOMContentLoaded', function() {
  state.required = requiredForLevel(state.level);
  updateRequiredUI();
  updateLevelUI();
});
