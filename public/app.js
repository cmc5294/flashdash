// ===== CONFIG =====
const CONFIG = {
  roundLength: 20,
  basePoints: 100,
  speedWindow: 10,        // seconds
  speedBonus: 100,
  multiplierStep: 0.1,
  multiplierCap: 2.0,
  autoAdvanceMs: 2200,
};

// ===== STATE =====
let state = {
  name: '',
  classCode: '',
  deckId: null,
  words: [],
  queue: [],
  cardIndex: 0,
  score: 0,
  streak: 0,
  maxStreak: 0,
  multiplier: 1.0,
  correct: 0,
  timerStart: 0,
  timerTimeout: null,
  locked: false,
  teacherPassword: null,
};

// ===== SCREEN HELPERS =====
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideError(el) { el.classList.add('hidden'); }

// ===== ENTRY =====
document.getElementById('entry-form').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = document.getElementById('entry-error');
  hideError(errEl);
  const name = document.getElementById('input-name').value.trim();
  const code = document.getElementById('input-code').value.trim().toUpperCase();
  if (!name || !code) return;

  try {
    const res = await fetch(`/deck?class=${encodeURIComponent(code)}`);
    if (!res.ok) {
      const d = await res.json();
      return showError(errEl, d.error || 'Could not load deck.');
    }
    const data = await res.json();
    if (!data.words || data.words.length < 4) {
      return showError(errEl, 'Deck has fewer than 4 words. Ask your teacher to upload a larger deck.');
    }
    state.name = name;
    state.classCode = code;
    state.deckId = data.deckId;
    state.words = data.words;
    startRound();
  } catch {
    showError(errEl, 'Connection error. Is the server running?');
  }
});

document.getElementById('btn-teacher-link').addEventListener('click', () => showScreen('screen-teacher'));

// ===== ROUND =====
function startRound() {
  state.queue = shuffle([...state.words]).slice(0, CONFIG.roundLength);
  state.cardIndex = 0;
  state.score = 0;
  state.streak = 0;
  state.maxStreak = 0;
  state.multiplier = 1.0;
  state.correct = 0;
  updateHUD();
  showScreen('screen-game');
  loadCard();
}

function loadCard() {
  const card = state.queue[state.cardIndex];
  state.locked = false;

  // Reset card to front
  document.getElementById('card').classList.remove('flipped');
  document.getElementById('card-feedback').textContent = '';
  document.getElementById('card-feedback').className = 'card-feedback';
  document.getElementById('card-back-word').textContent = '';
  document.getElementById('card-img').style.display = 'none';
  document.getElementById('card-img-placeholder').style.display = 'flex';
  document.getElementById('next-wrap').classList.add('hidden');

  // Set spanish word
  document.getElementById('card-spanish').textContent = card.spanish;

  // Update HUD progress
  updateHUD();

  // Build choices: 3 distractors + correct
  const distractors = shuffle(state.words.filter(w => w.english !== card.english)).slice(0, 3);
  const choices = shuffle([card, ...distractors]);
  renderChoices(choices, card);

  // Start timer
  startTimer();
}

function renderChoices(choices, correct) {
  const keys = ['1','2','3','4'];
  const el = document.getElementById('choices');
  el.innerHTML = '';
  choices.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.setAttribute('data-english', c.english);
    btn.setAttribute('aria-label', `Option ${i+1}: ${c.english}`);
    btn.innerHTML = `<span class="key-hint">${keys[i]}</span>${c.english}`;
    btn.addEventListener('click', () => handleAnswer(c.english, correct.english, btn));
    el.appendChild(btn);
  });
}

// ===== TIMER =====
function startTimer() {
  state.timerStart = performance.now();
  const bar = document.getElementById('timer-bar');
  bar.style.transition = 'none';
  bar.style.transform = 'scaleX(1)';
  // Force reflow
  bar.offsetWidth;
  bar.style.transition = `transform ${CONFIG.speedWindow}s linear`;
  bar.style.transform = 'scaleX(0)';

  clearTimeout(state.timerTimeout);
  state.timerTimeout = setTimeout(() => {
    if (!state.locked) handleAnswer(null, state.queue[state.cardIndex].english, null);
  }, CONFIG.speedWindow * 1000);
}

function stopTimer() {
  clearTimeout(state.timerTimeout);
  const bar = document.getElementById('timer-bar');
  bar.style.transition = 'none';
  bar.style.transform = bar.style.transform; // freeze
}

// ===== ANSWER =====
function handleAnswer(chosen, correct, chosenBtn) {
  if (state.locked) return;
  state.locked = true;
  stopTimer();

  const elapsed = (performance.now() - state.timerStart) / 1000;
  const isCorrect = chosen === correct;

  // Score
  let points = 0;
  if (isCorrect) {
    const speedBonus = Math.round(CONFIG.speedBonus * Math.max(0, (CONFIG.speedWindow - elapsed) / CONFIG.speedWindow));
    points = Math.round((CONFIG.basePoints + speedBonus) * state.multiplier);
    state.score += points;
    state.correct++;
    state.streak++;
    if (state.streak > state.maxStreak) state.maxStreak = state.streak;
    state.multiplier = Math.min(CONFIG.multiplierCap, 1.0 + Math.floor(state.streak) * CONFIG.multiplierStep);
  } else {
    state.streak = 0;
    state.multiplier = 1.0;
  }

  updateHUD();

  // Highlight buttons
  document.querySelectorAll('.choice-btn').forEach(btn => {
    btn.disabled = true;
    if (btn.getAttribute('data-english') === correct) btn.classList.add('correct');
    if (btn === chosenBtn && !isCorrect) btn.classList.add('wrong');
  });

  // Show score pop
  if (isCorrect && points > 0) showScorePop(`+${points}`);

  // High-streak confetti
  if (state.streak >= 5 && isCorrect) launchConfetti(8);
  if (state.streak >= 10 && isCorrect) launchConfetti(20);

  // Flip card after short delay
  setTimeout(() => {
    const card = state.queue[state.cardIndex];
    flipCard(card, isCorrect, correct, chosen);
  }, 350);
}

function flipCard(card, isCorrect, correctEnglish, chosen) {
  // Populate back
  const wordEl = document.getElementById('card-back-word');
  const feedEl = document.getElementById('card-feedback');
  wordEl.textContent = correctEnglish;

  if (isCorrect) {
    feedEl.textContent = '✓ Correct!';
    feedEl.className = 'card-feedback feedback-correct';
  } else {
    feedEl.textContent = chosen ? `✗ Was: ${correctEnglish}` : `✗ Time up! Was: ${correctEnglish}`;
    feedEl.className = 'card-feedback feedback-wrong';
  }

  // Structure the back correctly
  const back = document.querySelector('.card-back');
  back.innerHTML = '';
  const imgWrap = document.createElement('div');
  imgWrap.className = 'card-image-wrap';
  const img = document.createElement('img');
  img.id = 'card-img';
  img.alt = correctEnglish;
  img.className = 'card-img';
  const placeholder = document.createElement('div');
  placeholder.className = 'card-img-placeholder';
  placeholder.id = 'card-img-placeholder';
  placeholder.textContent = '🖼️';
  imgWrap.appendChild(img);
  imgWrap.appendChild(placeholder);

  const right = document.createElement('div');
  right.className = 'card-back-right';
  right.appendChild(wordEl);
  right.appendChild(feedEl);

  back.appendChild(imgWrap);
  back.appendChild(right);

  // Load image
  loadCardImage(card, img, placeholder);

  // Flip
  document.getElementById('card').classList.add('flipped');

  // Show next button + auto advance
  setTimeout(() => {
    document.getElementById('next-wrap').classList.remove('hidden');
    document.getElementById('btn-next').focus();
  }, 600);

  const advanceTimer = setTimeout(advance, CONFIG.autoAdvanceMs);
  document.getElementById('btn-next').onclick = () => { clearTimeout(advanceTimer); advance(); };
}

async function loadCardImage(card, imgEl, placeholder) {
  let url = card.image_url || null;
  if (!url) {
    try {
      const r = await fetch(`/image?term=${encodeURIComponent(card.english)}`);
      const d = await r.json();
      url = d.url || null;
    } catch { url = null; }
  }
  if (url) {
    imgEl.onload = () => { imgEl.style.display = 'block'; placeholder.style.display = 'none'; };
    imgEl.onerror = () => {};
    imgEl.src = url;
  }
}

function advance() {
  state.cardIndex++;
  if (state.cardIndex >= state.queue.length) {
    endRound();
  } else {
    loadCard();
  }
}

// ===== HUD =====
function updateHUD() {
  const total = state.queue.length || CONFIG.roundLength;
  document.getElementById('hud-progress').textContent = `Card ${state.cardIndex + 1} / ${total}`;
  document.getElementById('hud-score').textContent = `${state.score} pts`;

  const streakEl = document.getElementById('hud-streak');
  if (state.streak >= 2) {
    const fire = state.streak >= 5 ? '🔥' : '⚡';
    streakEl.textContent = `${fire} ${state.streak}× (${state.multiplier.toFixed(1)}x)`;
    streakEl.classList.remove('streak-bump');
    void streakEl.offsetWidth;
    streakEl.classList.add('streak-bump');
  } else {
    streakEl.textContent = '';
  }
}

// ===== SCORE POP =====
function showScorePop(text) {
  const el = document.getElementById('score-pop');
  el.textContent = text;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}

// ===== TTS =====
document.getElementById('btn-tts').addEventListener('click', () => {
  const word = document.getElementById('card-spanish').textContent;
  speak(word);
});

function speak(word) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(word);
  utt.lang = 'es-ES';
  const voices = window.speechSynthesis.getVoices();
  const spanish = voices.find(v => v.lang.startsWith('es'));
  if (spanish) utt.voice = spanish;
  window.speechSynthesis.speak(utt);
}

// Load voices early
if ('speechSynthesis' in window) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
}

// ===== KEYBOARD =====
document.addEventListener('keydown', e => {
  if (!document.getElementById('screen-game').classList.contains('active')) return;
  if (state.locked) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
      document.getElementById('btn-next')?.click();
    }
    return;
  }
  const map = { '1': 0, '2': 1, '3': 2, '4': 3 };
  if (e.key in map) {
    const btns = document.querySelectorAll('.choice-btn');
    btns[map[e.key]]?.click();
  }
});

// ===== END ROUND =====
async function endRound() {
  const accuracy = state.queue.length > 0 ? state.correct / state.queue.length : 0;
  // Post score
  try {
    await fetch('/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: state.name,
        classCode: state.classCode,
        deckId: state.deckId,
        score: state.score,
        accuracy,
        maxStreak: state.maxStreak,
      }),
    });
  } catch {}

  // Show results screen
  document.getElementById('res-score').textContent = state.score.toLocaleString();
  document.getElementById('res-accuracy').textContent = `${Math.round(accuracy * 100)}%`;
  document.getElementById('res-streak').textContent = state.maxStreak;

  // Load leaderboard
  try {
    const res = await fetch(`/leaderboard?class=${encodeURIComponent(state.classCode)}`);
    const data = await res.json();
    renderLeaderboard(data.entries, state.name, state.score);
  } catch {
    document.getElementById('leaderboard-table').textContent = 'Could not load leaderboard.';
  }

  launchConfetti(40);
  showScreen('screen-results');
}

function renderLeaderboard(entries, myName, myScore) {
  const rankBanner = document.getElementById('rank-banner');
  const tableEl = document.getElementById('leaderboard-table');
  tableEl.innerHTML = '';

  const myIndex = entries.findIndex(e => e.name === myName && e.score === myScore);
  rankBanner.textContent = myIndex >= 0 ? `You're ranked #${myIndex + 1} 🏆` : `Score posted!`;

  const show = entries.slice(0, 20);
  const needPin = myIndex >= 20;
  const pinEntry = needPin ? entries[myIndex] : null;

  show.forEach((entry, i) => {
    tableEl.appendChild(makeRow(i + 1, entry, entry.name === myName));
  });
  if (pinEntry) {
    const sep = document.createElement('div');
    sep.style.cssText = 'text-align:center;color:var(--text-dim);font-size:.8rem;padding:.4rem';
    sep.textContent = '···';
    tableEl.appendChild(sep);
    tableEl.appendChild(makeRow(myIndex + 1, pinEntry, true));
  }
}

function makeRow(rank, entry, isMe) {
  const row = document.createElement('div');
  row.className = 'lb-row' + (isMe ? ' me' : '');
  row.innerHTML = `
    <span class="lb-rank ${rank <= 3 ? 'top' : ''}">${rank <= 3 ? ['🥇','🥈','🥉'][rank-1] : rank}</span>
    <span class="lb-name">${escHtml(entry.name)}</span>
    <span class="lb-score">${entry.score.toLocaleString()}</span>
    <span class="lb-acc">${Math.round((entry.accuracy || 0) * 100)}%</span>
  `;
  return row;
}

document.getElementById('btn-play-again').addEventListener('click', startRound);

// ===== CONFETTI =====
function launchConfetti(count) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.getElementById('confetti-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const pieces = Array.from({ length: count }, () => ({
    x: Math.random() * canvas.width,
    y: -20,
    vx: (Math.random() - .5) * 6,
    vy: Math.random() * 4 + 3,
    color: ['#f5a623','#e94560','#2ecc71','#3498db','#9b59b6','#fff'][Math.floor(Math.random() * 6)],
    size: Math.random() * 8 + 5,
    angle: Math.random() * Math.PI * 2,
    spin: (Math.random() - .5) * .3,
    life: 1,
  }));

  let raf;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    pieces.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += .15;
      p.angle += p.spin;
      p.life -= .012;
      if (p.life > 0 && p.y < canvas.height + 20) {
        alive = true;
        ctx.save();
        ctx.globalAlpha = p.life;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size/2, -p.size/2, p.size, p.size * .5);
        ctx.restore();
      }
    });
    if (alive) raf = requestAnimationFrame(draw);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  cancelAnimationFrame(raf);
  draw();
}

// ===== TEACHER =====
document.getElementById('btn-teacher-back').addEventListener('click', () => showScreen('screen-entry'));

document.getElementById('btn-teacher-login').addEventListener('click', async () => {
  const pw = document.getElementById('teacher-password').value;
  const errEl = document.getElementById('teacher-auth-error');
  hideError(errEl);
  try {
    const res = await fetch('/teacher/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    const d = await res.json();
    if (d.ok) {
      state.teacherPassword = pw;
      document.getElementById('teacher-login-area').classList.add('hidden');
      document.getElementById('teacher-controls').classList.remove('hidden');
    } else {
      showError(errEl, 'Wrong password.');
    }
  } catch {
    showError(errEl, 'Connection error.');
  }
});

document.getElementById('btn-upload').addEventListener('click', async () => {
  const code = document.getElementById('teacher-class-code').value.trim().toUpperCase();
  const fileInput = document.getElementById('teacher-csv');
  const resultEl = document.getElementById('upload-result');
  resultEl.className = 'result-msg hidden';

  if (!code) { resultEl.textContent = 'Enter a class code.'; resultEl.className = 'result-msg err'; return; }
  if (!fileInput.files[0]) { resultEl.textContent = 'Select a CSV file.'; resultEl.className = 'result-msg err'; return; }

  const form = new FormData();
  form.append('classCode', code);
  form.append('csv', fileInput.files[0]);

  try {
    const res = await fetch('/deck', {
      method: 'POST',
      headers: { 'x-teacher-password': state.teacherPassword },
      body: form,
    });
    const d = await res.json();
    if (d.ok) {
      resultEl.textContent = `✓ Uploaded ${d.words} words for ${code}.` + (d.errors?.length ? ` (${d.errors.length} rows skipped)` : '');
      resultEl.className = 'result-msg ok';
    } else {
      resultEl.textContent = d.error || 'Upload failed.';
      resultEl.className = 'result-msg err';
    }
  } catch {
    resultEl.textContent = 'Connection error.';
    resultEl.className = 'result-msg err';
  }
});

document.getElementById('btn-reset').addEventListener('click', async () => {
  const code = document.getElementById('teacher-reset-code').value.trim().toUpperCase();
  const resultEl = document.getElementById('reset-result');
  resultEl.className = 'result-msg hidden';
  if (!code) { resultEl.textContent = 'Enter a class code.'; resultEl.className = 'result-msg err'; return; }
  if (!confirm(`Reset leaderboard for ${code}? This cannot be undone.`)) return;

  try {
    const res = await fetch('/leaderboard/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-teacher-password': state.teacherPassword },
      body: JSON.stringify({ classCode: code }),
    });
    const d = await res.json();
    resultEl.textContent = d.ok ? `✓ Leaderboard for ${code} cleared.` : d.error;
    resultEl.className = `result-msg ${d.ok ? 'ok' : 'err'}`;
  } catch {
    resultEl.textContent = 'Connection error.';
    resultEl.className = 'result-msg err';
  }
});

// ===== UTILS =====
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
