// ===== CONFIG =====
const CONFIG = {
  roundLength: 20,
  basePoints: 100,
  speedWindow: 10,
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
  scoreId: null,
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
  imageCache: {},   // english term -> url (prefetched)
};

// ===== TTS SETUP =====
// audioCache avoids re-fetching the same word twice in a round
const audioCache = {};
let ttsVoice = null;

function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  const voices = window.speechSynthesis.getVoices();
  ttsVoice = voices.find(v => v.lang === 'es-ES' && v.localService) ||
             voices.find(v => v.lang.startsWith('es') && v.localService) ||
             voices.find(v => v.lang === 'es-ES') ||
             voices.find(v => v.lang.startsWith('es')) ||
             null;
}

if ('speechSynthesis' in window) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
  loadVoices();
}

function speakFallback(word) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(word);
  utt.lang = 'es-ES';
  utt.rate = 0.85;
  if (ttsVoice) utt.voice = ttsVoice;
  window.speechSynthesis.speak(utt);
}

async function speak(word) {
  // Try Speechify proxy first; fall back to browser TTS
  if (audioCache[word]) {
    playAudioBlob(audioCache[word]);
    return;
  }
  try {
    const res = await fetch(`/tts?text=${encodeURIComponent(word)}`);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      if (d.error === 'no_key') {
        // Server has no Speechify key — use browser TTS silently
        speakFallback(word);
      }
      return;
    }
    const blob = await res.blob();
    audioCache[word] = blob;
    playAudioBlob(blob);
  } catch {
    speakFallback(word);
  }
}

function playAudioBlob(blob) {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  audio.play().catch(() => {});
}

// ===== SCREEN HELPERS =====
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function showError(el, msg) { el.textContent = msg; el.classList.remove('hidden'); }
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
  state.scoreId = null;
  state.imageCache = {};
  updateHUD();
  showScreen('screen-game');
  prefetchImages();
  loadCard();
}

// Prefetch all images in the background so first card flip is instant
async function prefetchImages() {
  for (const word of state.queue) {
    if (word.image_url) {
      state.imageCache[word.english] = word.image_url;
      continue;
    }
    try {
      const r = await fetch(`/image?term=${encodeURIComponent(word.english)}`);
      const d = await r.json();
      if (d.url) state.imageCache[word.english] = d.url;
    } catch {}
  }
}

function loadCard() {
  const card = state.queue[state.cardIndex];
  state.locked = false;

  document.getElementById('card').classList.remove('flipped');
  document.getElementById('next-wrap').classList.add('hidden');
  updateHUD();

  document.getElementById('card-spanish').textContent = card.spanish;

  const distractors = shuffle(state.words.filter(w => w.english !== card.english)).slice(0, 3);
  const choices = shuffle([card, ...distractors]);
  renderChoices(choices, card);

  startTimer();

  // Auto-play pronunciation after a short delay so the card feels ready
  setTimeout(() => speak(card.spanish), 300);
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
  bar.offsetWidth; // force reflow
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
}

// ===== ANSWER =====
function handleAnswer(chosen, correct, chosenBtn) {
  if (state.locked) return;
  state.locked = true;
  stopTimer();

  const elapsed = (performance.now() - state.timerStart) / 1000;
  const isCorrect = chosen === correct;
  const card = state.queue[state.cardIndex];

  // Score
  let points = 0;
  if (isCorrect) {
    const speedBonus = Math.round(CONFIG.speedBonus * Math.max(0, (CONFIG.speedWindow - elapsed) / CONFIG.speedWindow));
    points = Math.round((CONFIG.basePoints + speedBonus) * state.multiplier);
    state.score += points;
    state.correct++;
    state.streak++;
    if (state.streak > state.maxStreak) state.maxStreak = state.streak;
    state.multiplier = Math.min(CONFIG.multiplierCap, 1.0 + state.streak * CONFIG.multiplierStep);
  } else {
    state.streak = 0;
    state.multiplier = 1.0;
  }

  updateHUD();

  // Post attempt (fire-and-forget; we need scoreId which comes back after endRound posts the score,
  // so we queue attempts and flush them when scoreId is available)
  state._pendingAttempts = state._pendingAttempts || [];
  state._pendingAttempts.push({
    spanish: card.spanish,
    english: card.english,
    chosen: chosen,
    correct: isCorrect,
    seconds: parseFloat(elapsed.toFixed(2)),
  });

  // Highlight buttons
  document.querySelectorAll('.choice-btn').forEach(btn => {
    btn.disabled = true;
    if (btn.getAttribute('data-english') === correct) btn.classList.add('correct');
    if (btn === chosenBtn && !isCorrect) btn.classList.add('wrong');
  });

  if (isCorrect && points > 0) showScorePop(`+${points}`);
  if (state.streak >= 5 && isCorrect) launchConfetti(8);
  if (state.streak >= 10 && isCorrect) launchConfetti(20);

  setTimeout(() => flipCard(card, isCorrect, correct, chosen), 350);
}

function flipCard(card, isCorrect, correctEnglish, chosen) {
  const back = document.querySelector('.card-back');
  back.innerHTML = '';

  const imgWrap = document.createElement('div');
  imgWrap.className = 'card-image-wrap';
  const img = document.createElement('img');
  img.alt = correctEnglish;
  img.className = 'card-img';
  const placeholder = document.createElement('div');
  placeholder.className = 'card-img-placeholder';
  placeholder.textContent = '🖼️';
  imgWrap.appendChild(img);
  imgWrap.appendChild(placeholder);

  const right = document.createElement('div');
  right.className = 'card-back-right';

  const wordEl = document.createElement('div');
  wordEl.className = 'card-back-word';
  wordEl.textContent = correctEnglish;

  const feedEl = document.createElement('div');
  feedEl.className = 'card-feedback ' + (isCorrect ? 'feedback-correct' : 'feedback-wrong');
  feedEl.textContent = isCorrect
    ? '✓ Correct!'
    : chosen ? `✗ Was: ${correctEnglish}` : `✗ Time up! Was: ${correctEnglish}`;

  right.appendChild(wordEl);
  right.appendChild(feedEl);
  back.appendChild(imgWrap);
  back.appendChild(right);

  // Use prefetched image (instant) or show placeholder
  const cachedUrl = state.imageCache[card.english];
  if (cachedUrl) {
    img.onload = () => { img.style.display = 'block'; placeholder.style.display = 'none'; };
    img.src = cachedUrl;
  }

  document.getElementById('card').classList.add('flipped');

  setTimeout(() => {
    document.getElementById('next-wrap').classList.remove('hidden');
    document.getElementById('btn-next').focus();
  }, 600);

  const advanceTimer = setTimeout(advance, CONFIG.autoAdvanceMs);
  document.getElementById('btn-next').onclick = () => { clearTimeout(advanceTimer); advance(); };
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

// ===== TTS BUTTON =====
document.getElementById('btn-tts').addEventListener('click', () => {
  speak(document.getElementById('card-spanish').textContent);
});

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
  if (e.key in map) document.querySelectorAll('.choice-btn')[map[e.key]]?.click();
});

// ===== END ROUND =====
async function endRound() {
  const accuracy = state.queue.length > 0 ? state.correct / state.queue.length : 0;

  // Post round score first (to get scoreId)
  try {
    const res = await fetch('/score', {
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
    const d = await res.json();
    state.scoreId = d.scoreId;
  } catch {}

  // Flush per-card attempts now that we have scoreId
  if (state.scoreId && state._pendingAttempts?.length) {
    for (const attempt of state._pendingAttempts) {
      fetch('/attempt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scoreId: state.scoreId,
          name: state.name,
          classCode: state.classCode,
          ...attempt,
        }),
      }).catch(() => {});
    }
    state._pendingAttempts = [];
  }

  document.getElementById('res-score').textContent = state.score.toLocaleString();
  document.getElementById('res-accuracy').textContent = `${Math.round(accuracy * 100)}%`;
  document.getElementById('res-streak').textContent = state.maxStreak;

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

  show.forEach((entry, i) => tableEl.appendChild(makeRow(i + 1, entry, entry.name === myName)));

  if (needPin) {
    const sep = document.createElement('div');
    sep.style.cssText = 'text-align:center;color:var(--text-dim);font-size:.8rem;padding:.4rem';
    sep.textContent = '···';
    tableEl.appendChild(sep);
    tableEl.appendChild(makeRow(myIndex + 1, entries[myIndex], true));
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
    x: Math.random() * canvas.width, y: -20,
    vx: (Math.random() - .5) * 6, vy: Math.random() * 4 + 3,
    color: ['#f5a623','#e94560','#2ecc71','#3498db','#9b59b6','#fff'][Math.floor(Math.random() * 6)],
    size: Math.random() * 8 + 5, angle: Math.random() * Math.PI * 2,
    spin: (Math.random() - .5) * .3, life: 1,
  }));
  let raf;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    pieces.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.vy += .15;
      p.angle += p.spin; p.life -= .012;
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

// ===== TEACHER SCORES VIEW =====
document.getElementById('btn-view-scores').addEventListener('click', async () => {
  const code = document.getElementById('teacher-scores-code').value.trim().toUpperCase();
  const resultEl = document.getElementById('scores-result');
  const panelEl = document.getElementById('scores-panel');
  resultEl.className = 'result-msg hidden';
  panelEl.innerHTML = '';
  if (!code) { resultEl.textContent = 'Enter a class code.'; resultEl.className = 'result-msg err'; return; }

  try {
    const res = await fetch(`/teacher/scores?class=${encodeURIComponent(code)}`, {
      headers: { 'x-teacher-password': state.teacherPassword },
    });
    const d = await res.json();
    if (d.error) { resultEl.textContent = d.error; resultEl.className = 'result-msg err'; return; }

    // Summary table
    if (!d.rounds.length) {
      panelEl.innerHTML = '<p style="color:var(--text-dim)">No rounds played yet for this class.</p>';
      return;
    }

    // Most missed words
    if (d.mostMissed.length) {
      const h = document.createElement('h4');
      h.textContent = '⚠️ Most Missed Words';
      h.style.marginBottom = '.5rem';
      panelEl.appendChild(h);
      const missedTable = document.createElement('div');
      missedTable.className = 'scores-table';
      missedTable.innerHTML = `<div class="scores-header"><span>Spanish</span><span>English</span><span>Times Missed</span></div>`;
      d.mostMissed.slice(0, 10).forEach(w => {
        const row = document.createElement('div');
        row.className = 'scores-row';
        row.innerHTML = `<span>${escHtml(w.spanish)}</span><span>${escHtml(w.english)}</span><span style="color:var(--red);font-weight:700">${w.wrong_count}</span>`;
        missedTable.appendChild(row);
      });
      panelEl.appendChild(missedTable);
    }

    const h2 = document.createElement('h4');
    h2.textContent = '📋 All Rounds';
    h2.style.margin = '1rem 0 .5rem';
    panelEl.appendChild(h2);

    const roundTable = document.createElement('div');
    roundTable.className = 'scores-table';
    roundTable.innerHTML = `<div class="scores-header"><span>Student</span><span>Score</span><span>Accuracy</span><span>Streak</span><span>Played</span></div>`;
    d.rounds.forEach(r => {
      const row = document.createElement('div');
      row.className = 'scores-row';
      row.innerHTML = `
        <span>${escHtml(r.name)}</span>
        <span style="color:var(--gold);font-weight:700">${r.score.toLocaleString()}</span>
        <span>${Math.round(r.accuracy * 100)}%</span>
        <span>${r.max_streak}</span>
        <span style="font-size:.78rem;color:var(--text-dim)">${r.played_at}</span>
      `;
      roundTable.appendChild(row);
    });
    panelEl.appendChild(roundTable);

    // Download buttons
    const dlWrap = document.createElement('div');
    dlWrap.style.cssText = 'display:flex;gap:.75rem;margin-top:1rem;flex-wrap:wrap';
    dlWrap.innerHTML = `
      <a class="btn btn-primary" href="/teacher/export?class=${encodeURIComponent(code)}&type=rounds" download
         style="text-decoration:none;font-size:.85rem;padding:.55rem 1rem"
         onclick="this.setAttribute('href', this.href)"
         id="dl-rounds">⬇ Download Rounds CSV</a>
      <a class="btn btn-primary" href="/teacher/export?class=${encodeURIComponent(code)}&type=attempts" download
         style="text-decoration:none;background:var(--accent2);font-size:.85rem;padding:.55rem 1rem"
         id="dl-attempts">⬇ Download Per-Card CSV</a>
    `;
    panelEl.appendChild(dlWrap);

    // Inject auth header into download links via fetch+blob
    dlWrap.querySelectorAll('a[download]').forEach(link => {
      link.addEventListener('click', async e => {
        e.preventDefault();
        const href = link.getAttribute('href');
        try {
          const r = await fetch(href, { headers: { 'x-teacher-password': state.teacherPassword } });
          const blob = await r.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = link.getAttribute('download') || 'export.csv';
          a.click();
          URL.revokeObjectURL(url);
        } catch { alert('Download failed.'); }
      });
    });

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
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
