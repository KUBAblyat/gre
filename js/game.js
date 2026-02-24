// ============================================================
//  GEODUELER — GAME LOGIC v3
// ============================================================

const State = {
  playerId: null,
  playerName: "",
  room: null,
  players: [],
  isHost: false,
  currentRound: null,
  roundData: null,
  locations: [],
  guessMarker: null,
  guessConfirmed: false,
  score: 0,
  roundScores: [],
  timer: null,
  timeLeft: 0,
  channel: null,
  guessMap: null,
  resultsMap: null,
  isSolo: false,
  _resultLayers: [],
  _lobbyPollTimer: null,
  _autoConfirmTimeout: null,
  _autoConfirmInterval: null,
  // For showing other players' live guesses
  _otherGuessMarkers: {},
  // Ready state
  _readyPlayers: new Set(),
};

// ── INIT ──────────────────────────────────────────────────

function initGame() {
  State.playerId = generatePlayerId();
  initSupabase();
  setupUI();
  loadScreen("menu");
}

// ── SCORING ───────────────────────────────────────────────

function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calculateScore(distanceKm) {
  if (distanceKm <= 0.1) return CONFIG.MAX_SCORE_PER_ROUND;
  return Math.max(0, Math.round(CONFIG.MAX_SCORE_PER_ROUND * Math.exp(-distanceKm / 2000)));
}

function formatDistance(km) {
  if (km < 1)   return `${Math.round(km * 1000)} м`;
  if (km < 100) return `${km.toFixed(1)} км`;
  return `${Math.round(km)} км`;
}

// ── SCREEN ────────────────────────────────────────────────

function loadScreen(name) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  const s = document.getElementById(`screen-${name}`);
  if (s) s.classList.add("active");
  if (name === "game" && State.guessMap) setTimeout(() => State.guessMap.invalidateSize(), 100);
}

// ── SOLO ──────────────────────────────────────────────────

async function startSoloGame() {
  const nameInput = document.getElementById("player-name-input");
  const name = nameInput?.value.trim() || "";
  if (!name) { showToast("Введи своє ім'я!"); nameInput?.focus(); return; }
  State.playerName = name;

  State.isSolo = true;
  State.room = null;
  State.channel = null;
  State.score = 0;
  State.roundScores = [];
  State.currentRound = 0;
  State.locations = getRandomLocations(CONFIG.DEFAULT_ROUNDS);

  loadScreen("game");
  initGuessMap();
  await startRound(0);
}

// ── MULTIPLAYER ───────────────────────────────────────────

async function createMultiplayerRoom() {
  const name = document.getElementById("join-name-input").value.trim() ||
               document.getElementById("player-name-input").value.trim();
  if (!name) { showToast("Введи своє ім'я!"); document.getElementById("join-name-input")?.focus(); return; }
  State.playerName = name;

  const rounds    = parseInt(document.getElementById("rounds-select").value) || CONFIG.DEFAULT_ROUNDS;
  const timeLimit = parseInt(document.getElementById("time-select").value)   || CONFIG.DEFAULT_TIME_LIMIT;

  showLoading("Створення кімнати...");
  const room = await createRoom(State.playerId, name, { rounds, timeLimit });
  if (!room) { hideLoading(); showToast("Помилка. Перевір Supabase у config.js"); return; }

  State.room = room;
  State.isHost = true;
  State.players = [{ id: State.playerId, name, score: 0, is_host: true, ready: false }];
  hideLoading();
  enterLobby();
}

async function joinMultiplayerRoom() {
  const name = document.getElementById("join-name-input").value.trim();
  const code = document.getElementById("room-code-input").value.trim().toUpperCase();
  if (!name) { showToast("Введи своє ім'я!"); return; }
  if (!code || code.length !== 6) { showToast("Введи 6-значний код!"); return; }
  State.playerName = name;

  showLoading("Підключення...");
  const room = await getRoomByCode(code);
  if (!room)                     { hideLoading(); showToast("Кімната не знайдена!"); return; }
  if (room.status !== "waiting") { hideLoading(); showToast("Гра вже почалася!"); return; }

  const player = await joinRoomAsPlayer(room.id, State.playerId, name, false);
  if (!player) { hideLoading(); showToast("Помилка підключення!"); return; }

  State.room = room;
  State.isHost = false;
  State.players = await getPlayersInRoom(room.id);
  hideLoading();
  enterLobby();
}

function enterLobby() {
  loadScreen("lobby");
  renderLobby();
  subscribeToLobby();
  startLobbyPolling(); // Fallback polling to ensure lobby updates
}

// ── LOBBY POLLING (fallback for realtime issues) ──────────

function startLobbyPolling() {
  stopLobbyPolling();
  State._lobbyPollTimer = setInterval(async () => {
    if (!State.room) { stopLobbyPolling(); return; }
    const players = await getPlayersInRoom(State.room.id);
    if (players.length !== State.players.length ||
        JSON.stringify(players.map(p=>p.id).sort()) !== JSON.stringify(State.players.map(p=>p.id).sort())) {
      State.players = players;
      renderLobby();
    }
  }, 2000);
}

function stopLobbyPolling() {
  if (State._lobbyPollTimer) { clearInterval(State._lobbyPollTimer); State._lobbyPollTimer = null; }
}

function subscribeToLobby() {
  if (State.channel) unsubscribe(State.channel);
  State.channel = subscribeToRoom(State.room.id, {
    onPlayerChange: async () => {
      State.players = await getPlayersInRoom(State.room.id);
      renderLobby();
    },
    onRoomChange: async (room) => {
      State.room = room;
      if (room.status === "playing" && !State.isHost) {
        stopLobbyPolling();
        // Wait a bit to ensure GAME_STARTING broadcast with locations arrives first
        await sleep(800);
        if (!State.locations || State.locations.length === 0) {
          // Locations not received yet, wait more
          await sleep(1000);
        }
        await startMultiplayerGame();
      }
    },
    onGameEvent:   handleGameEvent,
    onNewGuess:    handleNewGuessEvent,
    onGuessUpdate: handleGuessUpdateEvent,
    onReadyUpdate: handleReadyUpdateEvent,
  });
}

function renderLobby() {
  document.getElementById("lobby-code").textContent = State.room.code;
  document.getElementById("lobby-round-info").textContent =
    `${State.room.max_rounds} раундів · ${State.room.time_limit}с`;

  document.getElementById("lobby-players").innerHTML = State.players.map(p => `
    <div class="lobby-player ${p.is_host ? "host" : ""}">
      <span class="player-avatar">${p.name[0].toUpperCase()}</span>
      <span class="player-name">${p.name}</span>
      ${p.is_host ? '<span class="host-badge">HOST</span>' : ''}
    </div>
  `).join("");

  const startBtn = document.getElementById("start-game-btn");
  const waitMsg  = document.getElementById("waiting-msg");

  if (State.isHost) {
    startBtn.style.display = "block";
    startBtn.disabled = State.players.length < 1;
    startBtn.textContent = `🚀 Почати гру! (${State.players.length} гравців)`;
    waitMsg.style.display = "none";
  } else {
    startBtn.style.display = "none";
    waitMsg.style.display = "block";
    waitMsg.textContent = `⏳ Чекаємо поки хост почне гру... (${State.players.length} гравців у лобі)`;
  }
}

async function hostStartGame() {
  if (!State.isHost) return;
  const btn = document.getElementById("start-game-btn");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Запуск..."; }

  State.locations = getRandomLocations(State.room.max_rounds);
  State.score = 0; State.roundScores = []; State.currentRound = 0;

  // Broadcast locations to other players FIRST
  broadcastGameEvent(State.channel, "GAME_STARTING", { locations: State.locations });
  await sleep(500);

  // Update DB so other players get onRoomChange trigger
  await updateRoomStatus(State.room.id, "playing", 0);
  await sleep(200);

  // Host starts game directly (doesn't wait for onRoomChange)
  stopLobbyPolling();
  loadScreen("game");
  initGuessMap();
  await startRound(0);
}

async function startMultiplayerGame() {
  stopLobbyPolling();
  loadScreen("game");
  initGuessMap();
  await startRound(0);
}

function handleGameEvent(payload) {
  const { event, data } = payload;
  if (event === "GAME_STARTING" && !State.isHost) {
    State.locations = data.locations;
    State.score = 0; State.roundScores = []; State.currentRound = 0;
  } else if (event === "ROUND_RESULTS") {
    showRoundResults(data);
  } else if (event === "NEXT_ROUND") {
    loadScreen("game");
    clearOtherGuessMarkers();
    if (State.guessMap) setTimeout(() => State.guessMap.invalidateSize(), 200);
    startRound(data.roundIndex);
  } else if (event === "GAME_OVER") {
    showFinalResults(data);
  }
}

function handleNewGuessEvent() { updateGuessCount(); }

function handleGuessUpdateEvent(data) {
  // Show other player's marker on the guess map in real-time
  if (!State.guessMap || data.playerId === State.playerId) return;
  if (State._otherGuessMarkers[data.playerId]) {
    State.guessMap.removeLayer(State._otherGuessMarkers[data.playerId]);
  }
  const color = "#3B82F6";
  const marker = L.circleMarker([data.lat, data.lng], {
    radius: 8, color: "#fff", fillColor: color, fillOpacity: 0.85, weight: 2,
  }).bindTooltip(data.playerName, { permanent: false });
  marker.addTo(State.guessMap);
  State._otherGuessMarkers[data.playerId] = marker;
  updateGuessCount();
}

function handleReadyUpdateEvent(data) {
  State._readyPlayers.add(data.playerId);
  updateReadyUI();
  // Host checks if all confirmed
  if (State.isHost) {
    const allReady = State.players.every(p => State._readyPlayers.has(p.id));
    if (allReady) proceedToNextRoundActual(data.roundIndex, data.isLast);
  }
}

function clearOtherGuessMarkers() {
  Object.values(State._otherGuessMarkers).forEach(m => {
    if (State.guessMap) State.guessMap.removeLayer(m);
  });
  State._otherGuessMarkers = {};
}

// ── ROUND ─────────────────────────────────────────────────

async function startRound(roundIndex) {
  State.currentRound  = roundIndex;
  State.guessMarker   = null;
  State.guessConfirmed = false;
  State._readyPlayers = new Set();
  clearOtherGuessMarkers();

  const location = State.locations[roundIndex];
  State.roundData = { ...location, roundIndex };

  if (!State.isSolo && State.isHost) {
    const round = await createRound(State.room.id, roundIndex, location.lat, location.lng);
    State.roundData.dbId = round?.id;
  } else if (!State.isSolo) {
    await sleep(800);
    const round = await getCurrentRound(State.room.id, roundIndex);
    if (round) State.roundData.dbId = round.id;
  }

  updateRoundUI(roundIndex);
  loadLocationImage(location);
  resetGuessMap();
  startTimer();
}

function updateRoundUI(roundIndex) {
  const maxRounds = State.isSolo ? CONFIG.DEFAULT_ROUNDS : State.room.max_rounds;
  document.getElementById("round-counter").textContent    = `${roundIndex + 1} / ${maxRounds}`;
  document.getElementById("total-score-display").textContent = State.score;
  document.getElementById("guess-count-display").textContent = "";
  document.getElementById("confirm-btn").disabled  = true;
  document.getElementById("confirm-btn").textContent = "Підтвердити здогадку";
}

async function updateGuessCount() {
  if (State.isSolo || !State.roundData?.dbId) return;
  const confirmed = Object.keys(State._otherGuessMarkers).length + (State.guessConfirmed ? 1 : 0);
  document.getElementById("guess-count-display").textContent =
    `Здогадок: ${confirmed}/${State.players.length}`;
}

function startTimer() {
  clearInterval(State.timer);
  const timeLimit = State.isSolo ? CONFIG.DEFAULT_TIME_LIMIT : State.room.time_limit;
  State.timeLeft = timeLimit;
  updateTimerUI();
  State.timer = setInterval(() => {
    State.timeLeft--;
    updateTimerUI();
    if (State.timeLeft <= 0) { clearInterval(State.timer); autoSubmitGuess(); }
  }, 1000);
}

function updateTimerUI() {
  const el = document.getElementById("timer-display");
  el.textContent = State.timeLeft;
  el.className = "timer-display" +
    (State.timeLeft <= 10 ? " urgent" : State.timeLeft <= 20 ? " warning" : "");
}

function autoSubmitGuess() { if (!State.guessConfirmed) confirmGuess(); }

// ── IMAGE ─────────────────────────────────────────────────

function loadLocationImage(location) {
  const img    = document.getElementById("location-image");
  const hint   = document.getElementById("location-hint");
  const loader = document.getElementById("image-loader");

  img.style.opacity = "0";
  loader.style.display = "flex";

  img.onload = () => { loader.style.display = "none"; img.style.opacity = "1"; };
  img.onerror = () => {
    loader.style.display = "none"; img.style.opacity = "1";
    img.src = `https://picsum.photos/seed/${location.lat}/1200/700`;
  };

  img.src = location.img;
  hint.textContent = location.hint || "";
}

// ── GUESS MAP ─────────────────────────────────────────────

function initGuessMap() {
  const el = document.getElementById("guess-map-canvas");
  if (State.guessMap) { State.guessMap.invalidateSize(); return; }
  State.guessMap = L.map(el, { center: [20, 10], zoom: 2, zoomControl: true, attributionControl: false });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18 }).addTo(State.guessMap);
  State.guessMap.on("click", onGuessMapClick);
}

function onGuessMapClick(e) {
  if (State.guessConfirmed) return;
  const { lat, lng } = e.latlng;

  if (State.guessMarker) State.guessMap.removeLayer(State.guessMarker);
  State.guessMarker = L.circleMarker([lat, lng], {
    radius: 10, color: "#fff", fillColor: "#F59E0B", fillOpacity: 1, weight: 2.5,
  }).addTo(State.guessMap);

  // Broadcast to others
  if (!State.isSolo && State.channel) {
    broadcastGuessUpdate(State.channel, { playerId: State.playerId, playerName: State.playerName, lat, lng });
  }

  const btn = document.getElementById("confirm-btn");
  btn.disabled = false;

  // Auto-confirm countdown
  clearTimeout(State._autoConfirmTimeout);
  clearInterval(State._autoConfirmInterval);
  let sec = 3;
  btn.textContent = `Підтвердити (${sec}с)`;
  State._autoConfirmInterval = setInterval(() => {
    sec--;
    if (sec > 0) btn.textContent = `Підтвердити (${sec}с)`;
    else { clearInterval(State._autoConfirmInterval); btn.textContent = "✓ Підтверджую..."; }
  }, 1000);
  State._autoConfirmTimeout = setTimeout(() => {
    if (!State.guessConfirmed && State.guessMarker) confirmGuess();
  }, 3000);
}

function resetGuessMap() {
  clearTimeout(State._autoConfirmTimeout);
  clearInterval(State._autoConfirmInterval);
  if (State.guessMarker && State.guessMap) {
    State.guessMap.removeLayer(State.guessMarker);
    State.guessMarker = null;
  }
  clearOtherGuessMarkers();
  const btn = document.getElementById("confirm-btn");
  btn.disabled = true;
  btn.textContent = "Підтвердити здогадку";
}

async function confirmGuess() {
  if (State.guessConfirmed) return;
  State.guessConfirmed = true;
  clearInterval(State.timer);
  clearTimeout(State._autoConfirmTimeout);
  clearInterval(State._autoConfirmInterval);

  document.getElementById("confirm-btn").disabled = true;
  document.getElementById("confirm-btn").textContent = "✓ Підтверджено";

  let guessLat, guessLng, distanceKm, roundScore;

  if (State.guessMarker) {
    const pos = State.guessMarker.getLatLng();
    guessLat = pos.lat; guessLng = pos.lng;
    distanceKm = haversineDistanceKm(State.roundData.lat, State.roundData.lng, guessLat, guessLng);
    roundScore = calculateScore(distanceKm);
  } else {
    guessLat = 0; guessLng = 0;
    distanceKm = CONFIG.MAX_DISTANCE_KM;
    roundScore = 0;
  }

  State.score += roundScore;
  State.roundScores.push({ roundScore, distanceKm, guessLat, guessLng });

  if (!State.isSolo && State.roundData.dbId) {
    await submitGuess(State.roundData.dbId, State.playerId, guessLat, guessLng, distanceKm, roundScore);
    await updatePlayerScore(State.playerId, roundScore);
  }

  if (State.isSolo) {
    collectAndShowRoundResults();
  } else {
    // Wait for all guesses then host shows results
    if (State.isHost) {
      const waitTime = 4000;
      setTimeout(() => collectAndShowRoundResults(), waitTime);
    }
  }
}

async function collectAndShowRoundResults() {
  let guesses = [];

  if (!State.isSolo && State.roundData.dbId) {
    const dbGuesses = await getGuessesForRound(State.roundData.dbId);
    guesses = dbGuesses.map(g => ({
      playerId: g.player_id,
      playerName: g.players?.name || "?",
      guessLat: g.guess_lat,
      guessLng: g.guess_lng,
      distanceKm: g.distance,
      score: g.score,
    }));
  } else {
    const rs = State.roundScores[State.roundScores.length - 1];
    guesses = [{
      playerId: State.playerId,
      playerName: State.playerName || "Ви",
      guessLat: rs.guessLat,
      guessLng: rs.guessLng,
      distanceKm: rs.distanceKm,
      score: rs.roundScore,
    }];
  }

  const resultsData = {
    roundIndex:    State.currentRound,
    targetLat:     State.roundData.lat,
    targetLng:     State.roundData.lng,
    targetCountry: State.roundData.country,
    targetCity:    State.roundData.city,
    targetImg:     State.roundData.img,
    guesses,
    myPlayerId: State.playerId,
  };

  if (!State.isSolo && State.isHost) {
    broadcastGameEvent(State.channel, "ROUND_RESULTS", resultsData);
  }
  showRoundResults(resultsData);
}

// ── ROUND RESULTS ─────────────────────────────────────────

function showRoundResults(data) {
  const maxRounds = State.isSolo ? CONFIG.DEFAULT_ROUNDS : State.room?.max_rounds || CONFIG.DEFAULT_ROUNDS;
  const isLast    = data.roundIndex >= maxRounds - 1;

  // Reset ready state
  State._readyPlayers = new Set();

  loadScreen("round-results");

  const myGuess = data.guesses.find(g => g.playerId === State.playerId);
  const myDist  = myGuess ? myGuess.distanceKm : CONFIG.MAX_DISTANCE_KM;
  const myScore = myGuess ? myGuess.score : 0;

  document.getElementById("result-distance").textContent = formatDistance(myDist);
  document.getElementById("result-score").textContent    = `+${myScore}`;
  document.getElementById("result-total").textContent    = State.score;
  document.getElementById("result-location-name").textContent =
    `${data.targetCity || ""}, ${data.targetCountry || ""}`;

  const revealImg = document.getElementById("reveal-image");
  if (revealImg && data.targetImg) revealImg.src = data.targetImg;

  const sorted = [...data.guesses].sort((a, b) => b.score - a.score);
  document.getElementById("round-scoreboard").innerHTML = sorted.map((g, i) => `
    <div class="scoreboard-row ${g.playerId === State.playerId ? "me" : ""}">
      <span class="rank">${i + 1}</span>
      <span class="sb-name">${g.playerName}</span>
      <span class="sb-dist">${formatDistance(g.distanceKm)}</span>
      <span class="sb-score">+${g.score}</span>
    </div>
  `).join("");

  const nextBtn = document.getElementById("next-round-btn");
  nextBtn.textContent = isLast ? "Фінал →" : (State.isSolo ? "Наступний раунд →" : "✅ Готовий!");
  nextBtn.onclick = () => handleReadyClick(data.roundIndex, isLast);

  setTimeout(() => initResultsMap(data), 200);
  updateReadyUI();
}

function updateReadyUI() {
  if (State.isSolo) return;
  const total = State.players.length;
  const ready = State._readyPlayers.size;
  const nextBtn = document.getElementById("next-round-btn");
  if (nextBtn && !State.isSolo) {
    const isLast = State.currentRound >= (State.room?.max_rounds || CONFIG.DEFAULT_ROUNDS) - 1;
    const myReady = State._readyPlayers.has(State.playerId);
    if (myReady) {
      nextBtn.textContent = `⏳ Чекаємо... (${ready}/${total})`;
      nextBtn.disabled = true;
    } else {
      nextBtn.textContent = isLast ? `✅ Готовий до фіналу! (${ready}/${total})` : `✅ Готовий! (${ready}/${total})`;
      nextBtn.disabled = false;
    }
  }
}

function handleReadyClick(roundIndex, isLast) {
  if (State.isSolo) { proceedToNextRoundActual(roundIndex, isLast); return; }

  // Add self to ready
  State._readyPlayers.add(State.playerId);
  broadcastReadyUpdate(State.channel, { playerId: State.playerId, roundIndex, isLast });
  updateReadyUI();

  // Check if all ready (host will also handle this via broadcast)
  const allReady = State.players.every(p => State._readyPlayers.has(p.id));
  if (allReady) proceedToNextRoundActual(roundIndex, isLast);
}

function proceedToNextRoundActual(currentRoundIndex, isLast) {
  if (isLast) { prepareAndShowFinal(); return; }

  const nextIndex = currentRoundIndex + 1;
  if (!State.isSolo && State.isHost) {
    broadcastGameEvent(State.channel, "NEXT_ROUND", { roundIndex: nextIndex });
  }
  loadScreen("game");
  clearOtherGuessMarkers();
  setTimeout(() => {
    if (State.guessMap) State.guessMap.invalidateSize();
    startRound(nextIndex);
  }, 100);
}

// ── RESULTS MAP ───────────────────────────────────────────

function initResultsMap(data) {
  const el = document.getElementById("results-map-canvas");

  if (State.resultsMap) {
    // ✅ FIX: Remove ALL old layers completely
    State._resultLayers.forEach(l => { try { State.resultsMap.removeLayer(l); } catch(e){} });
    State._resultLayers = [];
    State.resultsMap.setView([data.targetLat, data.targetLng], 4);
  } else {
    State.resultsMap = L.map(el, {
      center: [data.targetLat, data.targetLng], zoom: 4,
      zoomControl: true, attributionControl: false,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18 }).addTo(State.resultsMap);
  }

  const bounds = L.latLngBounds();

  const targetIcon = L.divIcon({
    html: `<div style="width:20px;height:20px;background:#22C55E;border:3px solid #fff;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.5)"></div>`,
    iconSize: [20, 20], iconAnchor: [10, 10], className: "",
  });
  const targetMarker = L.marker([data.targetLat, data.targetLng], { icon: targetIcon })
    .bindTooltip("📍 Правильне місце", { permanent: false });
  targetMarker.addTo(State.resultsMap);
  State._resultLayers.push(targetMarker);
  bounds.extend([data.targetLat, data.targetLng]);

  const colors = ["#F59E0B", "#3B82F6", "#EC4899", "#8B5CF6", "#14B8A6", "#F97316"];

  data.guesses.forEach((g, idx) => {
    if (!g.guessLat && !g.guessLng) return;
    const color = g.playerId === State.playerId ? "#F59E0B" : colors[idx % colors.length];

    const guessIcon = L.divIcon({
      html: `<div style="width:14px;height:14px;background:${color};border:2px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.4)"></div>`,
      iconSize: [14, 14], iconAnchor: [7, 7], className: "",
    });
    const gm = L.marker([g.guessLat, g.guessLng], { icon: guessIcon })
      .bindTooltip(`${g.playerName}: ${formatDistance(g.distanceKm)}`, { permanent: false });
    gm.addTo(State.resultsMap);
    State._resultLayers.push(gm);

    const line = L.polyline(
      [[g.guessLat, g.guessLng], [data.targetLat, data.targetLng]],
      { color, weight: 2, opacity: 0.7, dashArray: "6, 4" }
    ).addTo(State.resultsMap);
    State._resultLayers.push(line);
    bounds.extend([g.guessLat, g.guessLng]);
  });

  if (bounds.isValid()) {
    State.resultsMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 10 });
  }
  setTimeout(() => State.resultsMap.invalidateSize(), 150);
}

// ── FINAL ─────────────────────────────────────────────────

async function prepareAndShowFinal() {
  let finalPlayers = [];

  if (!State.isSolo) {
    finalPlayers = await getPlayersInRoom(State.room.id);
    await addToLeaderboard(State.playerName, State.score, State.room.max_rounds);
  } else {
    finalPlayers = [{ name: State.playerName || "Ви", score: State.score }];
    if (State.playerName) await addToLeaderboard(State.playerName, State.score, CONFIG.DEFAULT_ROUNDS);
  }

  const finalData = {
    players: finalPlayers.sort((a, b) => b.score - a.score),
    myPlayerId: State.playerId,
  };

  if (!State.isSolo && State.isHost) {
    broadcastGameEvent(State.channel, "GAME_OVER", finalData);
    await updateRoomStatus(State.room.id, "finished");
  }
  showFinalResults(finalData);
}

function showFinalResults(data) {
  loadScreen("final");
  const sorted = data.players;
  const myRank = sorted.findIndex(p => p.id === State.playerId) + 1 || 1;

  document.getElementById("final-score").textContent = State.score;
  document.getElementById("final-rank").textContent  = `#${myRank} з ${sorted.length}`;

  document.getElementById("final-scoreboard").innerHTML = sorted.map((p, i) => `
    <div class="scoreboard-row ${p.id === State.playerId ? "me" : ""}">
      <span class="rank rank-${i < 3 ? i + 1 : "other"}">${i + 1}</span>
      <span class="sb-name">${p.name}</span>
      <span class="sb-score">${p.score.toLocaleString()} очок</span>
    </div>
  `).join("");
}

// ── LEADERBOARD ───────────────────────────────────────────

async function loadLeaderboardScreen() {
  loadScreen("leaderboard");
  const list = document.getElementById("leaderboard-list");
  list.innerHTML = '<div class="loading-row">⏳ Завантаження...</div>';

  if (!getDB()) {
    list.innerHTML = '<div class="loading-row">⚠️ Supabase не підключено. Перевір config.js</div>';
    return;
  }

  const entries = await getLeaderboard(30);
  if (!entries || !entries.length) {
    list.innerHTML = '<div class="loading-row">Ще немає записів. Зіграй першим! 🎮</div>';
    return;
  }
  list.innerHTML = entries.map((e, i) => `
    <div class="lb-row ${i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : ""}">
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-name">${e.player_name}</span>
      <span class="lb-rounds">${e.rounds} р.</span>
      <span class="lb-score">${e.score.toLocaleString()}</span>
    </div>
  `).join("");
}

// ── UI ────────────────────────────────────────────────────

function setupUI() {
  const savedName = localStorage.getItem("geodueler_name") || "";
  ["player-name-input", "join-name-input"].forEach(id => {
    const el = document.getElementById(id);
    if (el && savedName) el.value = savedName;
    if (el) el.addEventListener("input", () => {
      State.playerName = el.value.trim();
      localStorage.setItem("geodueler_name", State.playerName);
      // Sync both fields
      ["player-name-input", "join-name-input"].forEach(otherId => {
        if (otherId !== id) {
          const other = document.getElementById(otherId);
          if (other) other.value = el.value;
        }
      });
    });
  });

  document.getElementById("map-toggle-btn")?.addEventListener("click", () => {
    const container = document.getElementById("guess-map-container");
    container.classList.toggle("expanded");
    document.getElementById("map-toggle-btn").textContent =
      container.classList.contains("expanded") ? "🗺 Згорнути" : "🗺 Карта";
    setTimeout(() => State.guessMap?.invalidateSize(), 300);
  });

  document.getElementById("copy-code-btn")?.addEventListener("click", () => {
    navigator.clipboard.writeText(document.getElementById("lobby-code").textContent)
      .then(() => showToast("Код скопійовано!"));
  });
}

function showToast(msg, duration = 3000) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), duration);
}

function showLoading(msg = "Завантаження...") {
  const el = document.getElementById("loading-overlay");
  if (el) { el.querySelector(".loading-text").textContent = msg; el.classList.add("visible"); }
}

function hideLoading() {
  document.getElementById("loading-overlay")?.classList.remove("visible");
}

function backToMenu() {
  clearInterval(State.timer);
  stopLobbyPolling();
  if (State.channel) unsubscribe(State.channel);
  if (!State.isSolo && State.room) removePlayer(State.playerId);
  Object.assign(State, {
    room: null, channel: null, isSolo: false, guessMarker: null,
    guessConfirmed: false, _otherGuessMarkers: {}, _readyPlayers: new Set(),
  });
  loadScreen("menu");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

window.addEventListener("DOMContentLoaded", () => { initGame(); });
