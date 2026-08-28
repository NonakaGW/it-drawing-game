import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  runTransaction,
  writeBatch,
  serverTimestamp,
  query,
  orderBy
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";
import { WORDS } from "./words.js";

const MAX_PLAYERS = 10;
const VIEW_SECONDS = 10;
const DRAW_SECONDS = 60;
const MIN_PLAYERS = 2;

const appElement = document.querySelector("#app");
const connectionStatus = document.querySelector("#connection-status");

let firebaseApp;
let auth;
let db;
let currentUser = null;

let currentRoomCode = null;
let currentRoom = null;
let currentPlayers = [];

let unsubscribeRoom = null;
let unsubscribePlayers = null;
let activeTimer = null;
let lastRenderedKey = "";
let submitting = false;

boot();

async function boot() {
  try {
    firebaseApp = initializeApp(firebaseConfig);
    auth = getAuth(firebaseApp);
    db = getFirestore(firebaseApp);

    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    updateOnlineStatus();

    onAuthStateChanged(auth, async (user) => {
      if (user) {
        currentUser = user;
        await restoreSession();
        return;
      }

      await signInAnonymously(auth);
    });
  } catch (error) {
    showFatalError(error);
  }
}

function updateOnlineStatus() {
  const online = navigator.onLine;
  connectionStatus.textContent = online ? "オンライン" : "オフライン";
  connectionStatus.className = `status-pill ${online ? "online" : "offline"}`;
}

async function restoreSession() {
  const saved = readSavedSession();

  if (!saved?.roomCode) {
    renderHome();
    return;
  }

  try {
    const roomRef = doc(db, "rooms", saved.roomCode);
    const playerRef = doc(db, "rooms", saved.roomCode, "players", currentUser.uid);

    const [roomSnap, playerSnap] = await Promise.all([
      getDoc(roomRef),
      getDoc(playerRef)
    ]);

    if (!roomSnap.exists() || !playerSnap.exists()) {
      clearSavedSession();
      renderHome();
      return;
    }

    enterRoom(saved.roomCode);
  } catch (error) {
    console.error(error);
    clearSavedSession();
    renderHome("前回の部屋を復元できませんでした。");
  }
}

function renderHome(message = "") {
  cleanupRoomListeners();
  clearActiveTimer();
  currentRoomCode = null;
  currentRoom = null;
  currentPlayers = [];
  lastRenderedKey = "";

  const template = document.querySelector("#home-template");
  appElement.replaceChildren(template.content.cloneNode(true));

  const createName = document.querySelector("#create-name");
  const joinName = document.querySelector("#join-name");
  const roomCodeInput = document.querySelector("#room-code");
  const error = document.querySelector("#home-error");

  const lastName = localStorage.getItem("it-drawing-player-name") ?? "";
  createName.value = lastName;
  joinName.value = lastName;
  error.textContent = message;

  document.querySelector("#create-room-button").addEventListener("click", async () => {
    const name = normalizeName(createName.value);
    if (!name) {
      error.textContent = "プレイヤー名を入力してください。";
      return;
    }

    setHomeBusy(true);
    try {
      await createRoom(name);
    } catch (err) {
      console.error(err);
      error.textContent = readableError(err);
      setHomeBusy(false);
    }
  });

  document.querySelector("#join-room-button").addEventListener("click", async () => {
    const name = normalizeName(joinName.value);
    const roomCode = normalizeRoomCode(roomCodeInput.value);

    if (!name) {
      error.textContent = "プレイヤー名を入力してください。";
      return;
    }

    if (roomCode.length !== 4) {
      error.textContent = "4文字のルームコードを入力してください。";
      return;
    }

    setHomeBusy(true);
    try {
      await joinRoom(roomCode, name);
    } catch (err) {
      console.error(err);
      error.textContent = readableError(err);
      setHomeBusy(false);
    }
  });

  roomCodeInput.addEventListener("input", () => {
    roomCodeInput.value = normalizeRoomCode(roomCodeInput.value);
  });
}

function setHomeBusy(busy) {
  document
    .querySelectorAll("#create-room-button, #join-room-button")
    .forEach((button) => {
      button.disabled = busy;
    });
}

async function createRoom(name) {
  const roomCode = await makeUniqueRoomCode();
  const roomRef = doc(db, "rooms", roomCode);
  const playerRef = doc(db, "rooms", roomCode, "players", currentUser.uid);

  const batch = writeBatch(db);

  batch.set(roomRef, {
    hostUid: currentUser.uid,
    status: "waiting",
    playerCount: 1,
    maxPlayers: MAX_PLAYERS,
    currentTurn: null,
    currentPlayerUid: null,
    playerOrder: [],
    turnStartedAt: null,
    answer: null,
    round: 0,
    createdAt: serverTimestamp()
  });

  batch.set(playerRef, {
    name,
    uid: currentUser.uid,
    order: null,
    joinedAt: serverTimestamp(),
    joinedAtMs: Date.now()
  });

  await batch.commit();

  rememberName(name);
  saveSession(roomCode);
  enterRoom(roomCode);
}

async function joinRoom(roomCode, name) {
  const roomRef = doc(db, "rooms", roomCode);
  const playerRef = doc(db, "rooms", roomCode, "players", currentUser.uid);

  await runTransaction(db, async (transaction) => {
    const roomSnap = await transaction.get(roomRef);
    const playerSnap = await transaction.get(playerRef);

    if (!roomSnap.exists()) {
      throw new Error("ROOM_NOT_FOUND");
    }

    const room = roomSnap.data();

    if (playerSnap.exists()) {
      transaction.update(playerRef, { name });
      return;
    }

    if (room.status !== "waiting") {
      throw new Error("GAME_ALREADY_STARTED");
    }

    if ((room.playerCount ?? 0) >= MAX_PLAYERS) {
      throw new Error("ROOM_FULL");
    }

    transaction.set(playerRef, {
      name,
      uid: currentUser.uid,
      order: null,
      joinedAt: serverTimestamp(),
      joinedAtMs: Date.now()
    });

    transaction.update(roomRef, {
      playerCount: (room.playerCount ?? 0) + 1
    });
  });

  rememberName(name);
  saveSession(roomCode);
  enterRoom(roomCode);
}

function enterRoom(roomCode) {
  cleanupRoomListeners();
  clearActiveTimer();

  currentRoomCode = roomCode;
  lastRenderedKey = "";

  const roomRef = doc(db, "rooms", roomCode);
  const playersRef = collection(db, "rooms", roomCode, "players");

  unsubscribeRoom = onSnapshot(
    roomRef,
    (snapshot) => {
      if (!snapshot.exists()) {
        clearSavedSession();
        renderHome("部屋が解散されました。");
        return;
      }

      currentRoom = snapshot.data();
      renderCurrentScreen();
    },
    (error) => showFatalError(error)
  );

  unsubscribePlayers = onSnapshot(
    playersRef,
    (snapshot) => {
      currentPlayers = snapshot.docs.map((item) => ({
        id: item.id,
        ...item.data()
      }));

      renderCurrentScreen();
    },
    (error) => showFatalError(error)
  );
}

function renderCurrentScreen() {
  if (!currentRoom || !currentRoomCode) return;

  const key = makeRenderKey();

  // 同一状態で Firestore の細かな更新が来ても Canvas を描き直さない。
  if (key === lastRenderedKey) {
    updateLobbyPlayerListIfPresent();
    return;
  }

  lastRenderedKey = key;
  clearActiveTimer();

  switch (currentRoom.status) {
    case "waiting":
      renderLobby();
      break;
    case "playing":
      renderPlaying();
      break;
    case "answering":
      renderAnswering();
      break;
    case "finished":
      renderResults();
      break;
    default:
      appElement.innerHTML = `<div class="center-message">不明なゲーム状態です。</div>`;
  }
}

function makeRenderKey() {
  const startMs = currentRoom.turnStartedAt?.toMillis?.() ?? "pending";
  return [
    currentRoom.status,
    currentRoom.round,
    currentRoom.currentTurn,
    currentRoom.currentPlayerUid,
    startMs,
    currentRoom.answer ?? "",
    currentPlayers.length
  ].join("|");
}

function renderLobby() {
  const host = currentRoom.hostUid === currentUser.uid;

  appElement.innerHTML = `
    <div class="room-head">
      <div>
        <p class="eyebrow">ROOM</p>
        <h2>ルームコード</h2>
        <div class="room-code">${escapeHtml(currentRoomCode)}</div>
        <p class="muted small">この4文字を参加者に伝えてください。</p>
      </div>
      <div class="room-head-actions">
        <button id="copy-code-button" class="secondary-button">コードをコピー</button>
        ${
          host
            ? `<button id="disband-room-button" class="danger-button">部屋を解散</button>`
            : ""
        }
      </div>
    </div>

    <section class="card">
      <h2>参加者 <span id="player-count">${currentPlayers.length}</span> / ${MAX_PLAYERS}</h2>
      <ul id="player-list" class="players"></ul>

      ${
        host
          ? `
            <button id="start-button" class="primary-button" ${
              currentPlayers.length < MIN_PLAYERS ? "disabled" : ""
            }>
              ゲーム開始
            </button>
            <p class="muted small">2人以上で開始できます。順番とお題は開始時にランダム決定します。</p>
          `
          : `<p class="muted">ホストがゲームを開始するまで待ってください。</p>`
      }
      <p id="lobby-error" class="error-message" aria-live="polite"></p>
    </section>
  `;

  updateLobbyPlayerListIfPresent();

  document.querySelector("#copy-code-button").addEventListener("click", async (event) => {
    try {
      await navigator.clipboard.writeText(currentRoomCode);
      event.currentTarget.textContent = "コピーしました";
      setTimeout(() => {
        if (event.currentTarget) event.currentTarget.textContent = "コードをコピー";
      }, 1200);
    } catch {
      // Clipboard API が使えない環境では何もしない。
    }
  });

  if (host) {
    document.querySelector("#disband-room-button")?.addEventListener("click", disbandRoom);


    document.querySelector("#start-button").addEventListener("click", async () => {
      const error = document.querySelector("#lobby-error");
      const button = document.querySelector("#start-button");

      button.disabled = true;
      error.textContent = "";

      try {
        await startRound();
      } catch (err) {
        console.error(err);
        error.textContent = readableError(err);
        button.disabled = false;
      }
    });
  }
}

function updateLobbyPlayerListIfPresent() {
  const list = document.querySelector("#player-list");
  const count = document.querySelector("#player-count");
  if (!list || !count) return;

  count.textContent = currentPlayers.length;

  const sorted = [...currentPlayers].sort((a, b) => {
    return (a.joinedAtMs ?? 0) - (b.joinedAtMs ?? 0);
  });

  list.innerHTML = sorted
    .map((player, index) => {
      const labels = [];
      if (player.id === currentRoom.hostUid) labels.push("ホスト");
      if (player.id === currentUser.uid) labels.push("あなた");

      return `
        <li class="player">
          <div class="player-main">
            <span class="player-number">${index + 1}</span>
            <strong>${escapeHtml(player.name)}</strong>
          </div>
          <span class="muted small">${labels.join(" / ")}</span>
        </li>
      `;
    })
    .join("");

  const startButton = document.querySelector("#start-button");
  if (startButton) {
    startButton.disabled = currentPlayers.length < MIN_PLAYERS;
  }
}

async function startRound() {
  const playersSnapshot = await getDocs(
    collection(db, "rooms", currentRoomCode, "players")
  );

  const players = playersSnapshot.docs.map((item) => ({
    id: item.id,
    ...item.data()
  }));

  if (players.length < MIN_PLAYERS) {
    throw new Error("NOT_ENOUGH_PLAYERS");
  }

  if (players.length > MAX_PLAYERS) {
    throw new Error("ROOM_FULL");
  }

  const order = shuffle(players.map((player) => player.id));
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  const roomRef = doc(db, "rooms", currentRoomCode);
  const secretRef = doc(db, "rooms", currentRoomCode, "secret", "prompt");
  const turnsRef = collection(db, "rooms", currentRoomCode, "turns");

  const oldTurns = await getDocs(turnsRef);
  const batch = writeBatch(db);

  oldTurns.forEach((turnDoc) => batch.delete(turnDoc.ref));

  players.forEach((player) => {
    batch.update(
      doc(db, "rooms", currentRoomCode, "players", player.id),
      { order: order.indexOf(player.id) }
    );
  });

  batch.set(secretRef, {
    word,
    firstPlayerUid: order[0],
    round: (currentRoom.round ?? 0) + 1
  });

  batch.update(roomRef, {
    status: "playing",
    playerCount: players.length,
    playerOrder: order,
    currentTurn: 0,
    currentPlayerUid: order[0],
    turnStartedAt: serverTimestamp(),
    answer: null,
    finishedAt: null,
    round: (currentRoom.round ?? 0) + 1
  });

  await batch.commit();
}

function renderPlaying() {
  const order = currentRoom.playerOrder ?? [];
  const myTurn = currentRoom.currentPlayerUid === currentUser.uid;
  const currentTurn = currentRoom.currentTurn ?? 0;
  const lastIndex = order.length - 1;

  if (!currentRoom.turnStartedAt?.toMillis) {
    renderTimerPreparing();
    return;
  }

  if (!myTurn) {
    renderWaitingForPlayer();
    return;
  }

  if (currentTurn === lastIndex) {
    // 通常は status=answering になるため、ここには来ない。
    renderAnswering();
    return;
  }

  if (currentTurn === 0) {
    renderFirstPlayerDrawing();
    return;
  }

  renderIntermediateTurn();
}

function renderTimerPreparing() {
  appElement.innerHTML = `
    ${renderGameTopbar()}
    <div class="center-message">
      <div>
        <h2>準備中...</h2>
        <p>タイマーを同期しています。</p>
      </div>
    </div>
  `;
}

function renderWaitingForPlayer() {
  const currentPlayer = getPlayerById(currentRoom.currentPlayerUid);
  const myOrder = getPlayerById(currentUser.uid)?.order;

  appElement.innerHTML = `
    ${renderGameTopbar()}
    <div class="waiting-box">
      <h2>${escapeHtml(currentPlayer?.name ?? "次のプレイヤー")}さんの番です</h2>
      <p class="muted">ほかの人の画面は見ないで待ってください。</p>
      ${
        Number.isInteger(myOrder)
          ? `<p><strong>あなたの順番：${myOrder + 1}番目</strong></p>`
          : ""
      }
    </div>
  `;
}

async function renderFirstPlayerDrawing() {
  const secretRef = doc(db, "rooms", currentRoomCode, "secret", "prompt");

  try {
    const secretSnap = await getDoc(secretRef);
    if (!secretSnap.exists()) {
      throw new Error("PROMPT_NOT_FOUND");
    }

    // 取得中にターンが変わっていた場合は描画画面を出さない。
    if (
      currentRoom.currentPlayerUid !== currentUser.uid ||
      currentRoom.currentTurn !== 0 ||
      currentRoom.status !== "playing"
    ) {
      return;
    }

    const word = secretSnap.data().word;

    appElement.innerHTML = `
      ${renderGameTopbar()}
      <div class="prompt-box">
        <p class="eyebrow">あなたにだけ見えるお題</p>
        <div class="prompt-word">${escapeHtml(word)}</div>
      </div>
      ${renderCanvasArea()}
    `;

    setupCanvas();
    startDrawCountdown(0);
  } catch (error) {
    console.error(error);
    appElement.innerHTML = `
      ${renderGameTopbar()}
      <div class="center-message">
        <div>
          <h2>お題を読み込めませんでした</h2>
          <p class="muted">Firestore Rules と匿名認証を確認してください。</p>
        </div>
      </div>
    `;
  }
}

async function renderIntermediateTurn() {
  const startMs = currentRoom.turnStartedAt.toMillis();
  const elapsedSeconds = Math.floor((Date.now() - startMs) / 1000);

  if (elapsedSeconds < VIEW_SECONDS) {
    await renderPreviousDrawingPreview();
    return;
  }

  appElement.innerHTML = `
    ${renderGameTopbar()}
    <div class="prompt-box">
      <h2>記憶だけで描いてください</h2>
      <p class="muted">前の絵はもう見られません。文字を書くのも禁止にするとさらに盛り上がります。</p>
    </div>
    ${renderCanvasArea()}
  `;

  setupCanvas();
  startDrawCountdown(VIEW_SECONDS);
}

async function renderPreviousDrawingPreview() {
  const previousTurn = (currentRoom.currentTurn ?? 0) - 1;
  const previousRef = doc(
    db,
    "rooms",
    currentRoomCode,
    "turns",
    String(previousTurn)
  );

  try {
    const previousSnap = await getDoc(previousRef);

    if (!previousSnap.exists()) {
      throw new Error("PREVIOUS_DRAWING_NOT_FOUND");
    }

    const image = previousSnap.data().drawingDataUrl;

    appElement.innerHTML = `
      ${renderGameTopbar()}
      <div class="preview-box">
        <h2>前の人の絵を覚えてください</h2>
        <p class="muted">10秒後に消えます。</p>
        <div id="view-timer" class="timer">10秒</div>
        <img class="preview-image" src="${image}" alt="前のプレイヤーが描いた絵">
      </div>
    `;

    startViewCountdown(() => {
      // 同じターンのままなら描画画面に切り替える。
      if (
        currentRoom.status === "playing" &&
        currentRoom.currentPlayerUid === currentUser.uid
      ) {
        lastRenderedKey = "";
        renderCurrentScreen();
      }
    });
  } catch (error) {
    console.error(error);
    appElement.innerHTML = `
      ${renderGameTopbar()}
      <div class="center-message">
        <div>
          <h2>前の絵を読み込めませんでした</h2>
          <p class="muted">少し待っても直らなければ再読み込みしてください。</p>
        </div>
      </div>
    `;
  }
}

function renderCanvasArea() {
  return `
    <div class="game-layout">
      <div class="canvas-tools">
        <div class="tool-group">
          <button class="secondary-button tool-button" data-width="4">細</button>
          <button class="secondary-button tool-button active" data-width="8">普通</button>
          <button class="secondary-button tool-button" data-width="14">太</button>
        </div>
        <div class="tool-group">
          <button id="clear-canvas-button" class="secondary-button">全部消す</button>
          <button id="submit-drawing-button" class="primary-button">この絵で決定</button>
        </div>
      </div>

      <div class="canvas-wrap">
        <canvas id="drawing-canvas" width="900" height="560"></canvas>
      </div>

      <p id="drawing-error" class="error-message" aria-live="polite"></p>
    </div>
  `;
}

function setupCanvas() {
  const canvas = document.querySelector("#drawing-canvas");
  const context = canvas.getContext("2d");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#111111";
  context.lineWidth = 8;
  context.lineCap = "round";
  context.lineJoin = "round";

  let drawing = false;
  let lastPoint = null;

  const pointFromEvent = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height
    };
  };

  canvas.addEventListener("pointerdown", (event) => {
    drawing = true;
    lastPoint = pointFromEvent(event);
    canvas.setPointerCapture(event.pointerId);

    // 点だけ描いた場合にも線が残るようにする。
    context.beginPath();
    context.moveTo(lastPoint.x, lastPoint.y);
    context.lineTo(lastPoint.x + 0.01, lastPoint.y + 0.01);
    context.stroke();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!drawing) return;

    const point = pointFromEvent(event);
    context.beginPath();
    context.moveTo(lastPoint.x, lastPoint.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    lastPoint = point;
  });

  const stopDrawing = () => {
    drawing = false;
    lastPoint = null;
  };

  canvas.addEventListener("pointerup", stopDrawing);
  canvas.addEventListener("pointercancel", stopDrawing);

  document.querySelectorAll("[data-width]").forEach((button) => {
    button.addEventListener("click", () => {
      context.lineWidth = Number(button.dataset.width);

      document.querySelectorAll("[data-width]").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
    });
  });

  document.querySelector("#clear-canvas-button").addEventListener("click", () => {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
  });

  document.querySelector("#submit-drawing-button").addEventListener("click", () => {
    submitDrawing();
  });
}

function startViewCountdown(onComplete) {
  clearActiveTimer();

  const startMs = currentRoom.turnStartedAt.toMillis();
  const timerElement = document.querySelector("#view-timer");

  const tick = () => {
    const elapsed = (Date.now() - startMs) / 1000;
    const remaining = Math.max(0, Math.ceil(VIEW_SECONDS - elapsed));

    if (timerElement) {
      timerElement.textContent = `${remaining}秒`;
      timerElement.classList.toggle("danger", remaining <= 3);
    }

    if (remaining <= 0) {
      clearActiveTimer();
      onComplete();
    }
  };

  tick();
  activeTimer = setInterval(tick, 200);
}

function startDrawCountdown(viewOffsetSeconds) {
  clearActiveTimer();

  const startMs = currentRoom.turnStartedAt.toMillis();
  const timerElement = document.querySelector("#main-timer");

  const tick = () => {
    const elapsed = (Date.now() - startMs) / 1000 - viewOffsetSeconds;
    const remaining = Math.max(0, Math.ceil(DRAW_SECONDS - elapsed));

    if (timerElement) {
      timerElement.textContent = `${remaining}秒`;
      timerElement.classList.toggle("danger", remaining <= 10);
    }

    if (remaining <= 0) {
      clearActiveTimer();
      submitDrawing(true);
    }
  };

  tick();
  activeTimer = setInterval(tick, 200);
}

async function submitDrawing(auto = false) {
  if (submitting) return;

  const canvas = document.querySelector("#drawing-canvas");
  if (!canvas) return;

  submitting = true;

  const button = document.querySelector("#submit-drawing-button");
  const error = document.querySelector("#drawing-error");

  if (button) {
    button.disabled = true;
    button.textContent = auto ? "時間切れ：送信中..." : "送信中...";
  }

  try {
    const drawingDataUrl = canvas.toDataURL("image/webp", 0.72);
    const roomRef = doc(db, "rooms", currentRoomCode);
    const turnNumber = currentRoom.currentTurn;
    const turnRef = doc(
      db,
      "rooms",
      currentRoomCode,
      "turns",
      String(turnNumber)
    );

    await runTransaction(db, async (transaction) => {
      const roomSnap = await transaction.get(roomRef);

      if (!roomSnap.exists()) {
        throw new Error("ROOM_NOT_FOUND");
      }

      const room = roomSnap.data();

      if (
        room.status !== "playing" ||
        room.currentPlayerUid !== currentUser.uid ||
        room.currentTurn !== turnNumber
      ) {
        throw new Error("TURN_ALREADY_CHANGED");
      }

      const nextTurn = turnNumber + 1;
      const nextUid = room.playerOrder[nextTurn];
      const isAnswerTurn = nextTurn === room.playerOrder.length - 1;

      transaction.set(turnRef, {
        turnIndex: turnNumber,
        playerUid: currentUser.uid,
        drawingDataUrl,
        createdAt: serverTimestamp(),
        round: room.round
      });

      transaction.update(roomRef, {
        currentTurn: nextTurn,
        currentPlayerUid: nextUid,
        status: isAnswerTurn ? "answering" : "playing",
        turnStartedAt: serverTimestamp()
      });
    });
  } catch (err) {
    console.error(err);

    if (err.message !== "TURN_ALREADY_CHANGED" && error) {
      error.textContent = readableError(err);
    }

    if (button) {
      button.disabled = false;
      button.textContent = "この絵で決定";
    }
  } finally {
    submitting = false;
  }
}

function renderAnswering() {
  const myTurn = currentRoom.currentPlayerUid === currentUser.uid;

  if (!currentRoom.turnStartedAt?.toMillis) {
    renderTimerPreparing();
    return;
  }

  if (!myTurn) {
    renderWaitingForPlayer();
    return;
  }

  const startMs = currentRoom.turnStartedAt.toMillis();
  const elapsedSeconds = Math.floor((Date.now() - startMs) / 1000);

  if (elapsedSeconds < VIEW_SECONDS) {
    renderAnswerPreview();
    return;
  }

  appElement.innerHTML = `
    ${renderGameTopbar(false)}
    <div class="answer-box">
      <p class="eyebrow">FINAL ANSWER</p>
      <h2>最後の回答です</h2>
      <p class="muted">さっき見た絵は何を表していたと思いますか？</p>

      <div class="answer-row">
        <input id="answer-input" class="text-input" type="text" maxlength="60" autocomplete="off" placeholder="答えを入力">
        <button id="submit-answer-button" class="primary-button">回答する</button>
      </div>
      <p id="answer-error" class="error-message" aria-live="polite"></p>
    </div>
  `;

  const input = document.querySelector("#answer-input");
  input.focus();

  document.querySelector("#submit-answer-button").addEventListener("click", submitAnswer);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submitAnswer();
  });
}

async function renderAnswerPreview() {
  const previousTurn = (currentRoom.currentTurn ?? 0) - 1;
  const previousRef = doc(
    db,
    "rooms",
    currentRoomCode,
    "turns",
    String(previousTurn)
  );

  try {
    const previousSnap = await getDoc(previousRef);
    if (!previousSnap.exists()) {
      throw new Error("PREVIOUS_DRAWING_NOT_FOUND");
    }

    appElement.innerHTML = `
      ${renderGameTopbar(false)}
      <div class="preview-box">
        <h2>これが何か当ててください</h2>
        <p class="muted">10秒だけ見られます。このあと絵は消えます。</p>
        <div id="view-timer" class="timer">10秒</div>
        <img class="preview-image" src="${previousSnap.data().drawingDataUrl}" alt="最後に伝わった絵">
      </div>
    `;

    startViewCountdown(() => {
      if (
        currentRoom.status === "answering" &&
        currentRoom.currentPlayerUid === currentUser.uid
      ) {
        lastRenderedKey = "";
        renderCurrentScreen();
      }
    });
  } catch (error) {
    console.error(error);
    appElement.innerHTML = `
      ${renderGameTopbar(false)}
      <div class="center-message">
        <div>
          <h2>前の絵を読み込めませんでした</h2>
          <p class="muted">少し待ってから再読み込みしてください。</p>
        </div>
      </div>
    `;
  }
}

async function submitAnswer() {
  if (submitting) return;

  const input = document.querySelector("#answer-input");
  const button = document.querySelector("#submit-answer-button");
  const error = document.querySelector("#answer-error");
  const answer = input.value.trim();

  if (!answer) {
    error.textContent = "答えを入力してください。";
    return;
  }

  submitting = true;
  button.disabled = true;

  try {
    const roomRef = doc(db, "rooms", currentRoomCode);

    await runTransaction(db, async (transaction) => {
      const roomSnap = await transaction.get(roomRef);

      if (!roomSnap.exists()) {
        throw new Error("ROOM_NOT_FOUND");
      }

      const room = roomSnap.data();

      if (
        room.status !== "answering" ||
        room.currentPlayerUid !== currentUser.uid
      ) {
        throw new Error("TURN_ALREADY_CHANGED");
      }

      transaction.update(roomRef, {
        answer,
        status: "finished",
        finishedAt: serverTimestamp()
      });
    });
  } catch (err) {
    console.error(err);
    error.textContent = readableError(err);
    button.disabled = false;
  } finally {
    submitting = false;
  }
}

async function renderResults() {
  appElement.innerHTML = `
    ${renderGameTopbar(false)}
    <div class="center-message">
      <div>
        <h2>結果を読み込み中...</h2>
      </div>
    </div>
  `;

  try {
    const secretRef = doc(db, "rooms", currentRoomCode, "secret", "prompt");
    const turnsQuery = query(
      collection(db, "rooms", currentRoomCode, "turns"),
      orderBy("turnIndex")
    );

    const [secretSnap, turnsSnap] = await Promise.all([
      getDoc(secretRef),
      getDocs(turnsQuery)
    ]);

    const word = secretSnap.exists() ? secretSnap.data().word : "不明";
    const turns = turnsSnap.docs.map((item) => item.data());
    const host = currentRoom.hostUid === currentUser.uid;

    const cards = turns
      .map((turn) => {
        const player = getPlayerById(turn.playerUid);
        return `
          <article class="result-card">
            <h3>${turn.turnIndex + 1}. ${escapeHtml(player?.name ?? "プレイヤー")}</h3>
            <img src="${turn.drawingDataUrl}" alt="${turn.turnIndex + 1}番目の絵">
          </article>
        `;
      })
      .join("");

    const answerPlayer = getPlayerById(currentRoom.currentPlayerUid);

    appElement.innerHTML = `
      ${renderGameTopbar(false)}
      <div class="results">
        <section class="result-hero">
          <p class="eyebrow">RESULT</p>
          <p>最初のお題</p>
          <strong>${escapeHtml(word)}</strong>
          <hr>
          <p>最後の回答</p>
          <strong>${escapeHtml(currentRoom.answer ?? "")}</strong>
          <p class="muted small">回答者：${escapeHtml(answerPlayer?.name ?? "プレイヤー")}</p>
        </section>

        <section>
          <h2>どう変わった？</h2>
          <div class="result-list">
            ${cards}
          </div>
        </section>

        ${
          host
            ? `
              <section class="card">
                <h2>もう一度遊ぶ</h2>
                <p>同じメンバーで、順番とお題をシャッフルして次のゲームを始めます。</p>
                <button id="next-round-button" class="primary-button">もう一度遊ぶ</button>
                <p id="result-error" class="error-message" aria-live="polite"></p>
              </section>
            `
            : `
              <section class="card">
                <p>ホストが次のゲームを開始できます。</p>
              </section>
            `
        }
      </div>
    `;

    if (host) {
      document.querySelector("#next-round-button").addEventListener("click", async () => {
        const button = document.querySelector("#next-round-button");
        const error = document.querySelector("#result-error");

        button.disabled = true;
        try {
          await startRound();
        } catch (err) {
          console.error(err);
          error.textContent = readableError(err);
          button.disabled = false;
        }
      });
    }
  } catch (error) {
    console.error(error);
    appElement.innerHTML = `
      ${renderGameTopbar(false)}
      <div class="center-message">
        <div>
          <h2>結果を読み込めませんでした</h2>
          <p class="muted">Firestore Rules を確認してください。</p>
        </div>
      </div>
    `;
  }
}

function renderGameTopbar(showTimer = true) {
  const turn = Number.isInteger(currentRoom.currentTurn)
    ? currentRoom.currentTurn + 1
    : "-";

  const total = currentRoom.playerOrder?.length ?? currentPlayers.length;
  const host = currentRoom.hostUid === currentUser.uid;

  // innerHTMLで画面を描き直した直後に、ホスト用「部屋を解散」ボタンへ
  // 共通イベントを付けるため、次のイベントループでバインドする。
  queueMicrotask(() => {
    document
      .querySelector("#disband-room-button")
      ?.addEventListener("click", disbandRoom);
  });

  return `
    <div class="game-topbar">
      <div>
        <span class="badge">ROOM ${escapeHtml(currentRoomCode)}</span>
        <span class="badge">${turn} / ${total}</span>
      </div>
      <div>
        ${showTimer ? `<span id="main-timer" class="timer">--秒</span>` : ""}
        ${
          host
            ? `<button id="disband-room-button" class="danger-button">部屋を解散</button>`
            : ""
        }
      </div>
    </div>
  `;
}

async function disbandRoom() {
  if (!currentRoomCode || !currentRoom) return;

  if (currentRoom.hostUid !== currentUser.uid) {
    return;
  }

  const confirmed = window.confirm(
    "ゲームを終了して部屋を解散します。\n参加者全員がトップ画面に戻ります。\nよろしいですか？"
  );

  if (!confirmed) return;

  clearActiveTimer();

  document
    .querySelectorAll("button")
    .forEach((button) => {
      button.disabled = true;
    });

  try {
    const roomCode = currentRoomCode;
    const roomRef = doc(db, "rooms", roomCode);
    const secretRef = doc(db, "rooms", roomCode, "secret", "prompt");
    const batch = writeBatch(db);

    // 参加者は最大10人なので、現在取得済みのプレイヤーを削除。
    currentPlayers.forEach((player) => {
      batch.delete(
        doc(db, "rooms", roomCode, "players", player.id)
      );
    });

    // turns は途中ゲームでも最大9枚程度。
    // Firestore Rules上、ホストが途中でturns一覧を読む必要がないよう、
    // 存在の有無に関係なく既知のIDを削除対象にする。
    for (let i = 0; i < MAX_PLAYERS; i += 1) {
      batch.delete(
        doc(db, "rooms", roomCode, "turns", String(i))
      );
    }

    // お題も削除。
    batch.delete(secretRef);

    // 最後に部屋本体を削除。
    batch.delete(roomRef);

    await batch.commit();

    clearSavedSession();
    cleanupRoomListeners();
    currentRoomCode = null;
    currentRoom = null;
    currentPlayers = [];
    lastRenderedKey = "";

    renderHome("部屋を解散しました。");
  } catch (error) {
    console.error(error);

    window.alert(
      readableError(error)
    );

    // 失敗した場合は画面を描画し直して操作可能に戻す。
    lastRenderedKey = "";
    renderCurrentScreen();
  }
}

function getPlayerById(uid) {
  return currentPlayers.find((player) => player.id === uid);
}

function cleanupRoomListeners() {
  if (unsubscribeRoom) unsubscribeRoom();
  if (unsubscribePlayers) unsubscribePlayers();

  unsubscribeRoom = null;
  unsubscribePlayers = null;
}

function clearActiveTimer() {
  if (activeTimer) {
    clearInterval(activeTimer);
    activeTimer = null;
  }
}

async function makeUniqueRoomCode() {
  for (let i = 0; i < 20; i += 1) {
    const code = randomRoomCode();
    const snapshot = await getDoc(doc(db, "rooms", code));

    if (!snapshot.exists()) {
      return code;
    }
  }

  throw new Error("ROOM_CODE_GENERATION_FAILED");
}

function randomRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(
    { length: 4 },
    () => chars[Math.floor(Math.random() * chars.length)]
  ).join("");
}

function normalizeName(value) {
  return value.trim().replace(/\s+/g, " ").slice(0, 20);
}

function normalizeRoomCode(value) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
}

function rememberName(name) {
  localStorage.setItem("it-drawing-player-name", name);
}

function saveSession(roomCode) {
  localStorage.setItem(
    "it-drawing-session",
    JSON.stringify({ roomCode })
  );
}

function readSavedSession() {
  try {
    return JSON.parse(localStorage.getItem("it-drawing-session"));
  } catch {
    return null;
  }
}

function clearSavedSession() {
  localStorage.removeItem("it-drawing-session");
}

function shuffle(values) {
  const result = [...values];

  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

function readableError(error) {
  const code = error?.message ?? error?.code ?? "";

  const messages = {
    ROOM_NOT_FOUND: "そのルームコードの部屋は見つかりませんでした。",
    GAME_ALREADY_STARTED: "この部屋はすでにゲーム開始済みです。",
    ROOM_FULL: "この部屋は10人で満員です。",
    NOT_ENOUGH_PLAYERS: "2人以上参加してから開始してください。",
    ROOM_CODE_GENERATION_FAILED: "ルームコードを作れませんでした。もう一度試してください。",
    TURN_ALREADY_CHANGED: "すでに次のターンへ進んでいます。",
    PROMPT_NOT_FOUND: "お題が見つかりませんでした。",
    PREVIOUS_DRAWING_NOT_FOUND: "前の人の絵が見つかりませんでした。"
  };

  if (messages[code]) return messages[code];

  if (String(error?.code).includes("permission-denied")) {
    return "Firestore の権限エラーです。firestore.rules を確認してください。";
  }

  if (String(error?.code).includes("auth")) {
    return "Firebase Authentication の設定を確認してください。";
  }

  return "エラーが発生しました。コンソールも確認してください。";
}

function showFatalError(error) {
  console.error(error);

  appElement.innerHTML = `
    <div class="center-message">
      <div>
        <h2>Firebase に接続できませんでした</h2>
        <p class="muted">firebase-config.js と Firebase の設定を確認してください。</p>
        <p class="error-message">${escapeHtml(error?.message ?? String(error))}</p>
      </div>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
