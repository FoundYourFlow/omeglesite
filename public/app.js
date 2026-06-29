// ---- DOM ----
const localVideo = document.getElementById("local-video");
const remoteVideo = document.getElementById("remote-video");
const remoteOverlay = document.getElementById("remote-overlay");
const remoteStatus = document.getElementById("remote-status");
const localOverlay = document.getElementById("local-overlay");
const statusEl = document.getElementById("status");
const statusText = document.getElementById("status-text");
const networkBanner = document.getElementById("network-banner");
const networkUrls = document.getElementById("network-urls");
const waitingBanner = document.getElementById("waiting-banner");
const waitingText = document.getElementById("waiting-text");
const chatMessages = document.getElementById("chat-messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const typingIndicator = document.getElementById("typing-indicator");
const startBtn = document.getElementById("start-btn");
const nextBtn = document.getElementById("next-btn");
const muteBtn = document.getElementById("mute-btn");
const cameraBtn = document.getElementById("camera-btn");

// ---- State ----
const clientId =
  (crypto.randomUUID && crypto.randomUUID()) ||
  Math.random().toString(36).slice(2) + Date.now().toString(36);

let localStream = null;
let peerConnection = null;
let pendingCandidates = [];
let remoteDescSet = false;
let makingOffer = false;

let isMuted = false;
let isCameraOff = false;
let started = false;
let isMatched = false;
let isWaiting = false;
let isInitiator = false;
let pollTimer = null;
let typingTimeout = null;
let sessionId = 0;
let iceRestartTries = 0;

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:openrelay.metered.ca:80" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
};

// Adaptive polling: fast while establishing the WebRTC connection,
// slower once connected (chat/keepalive) or idle in the queue.
const POLL_WAITING_MS = 900;
const POLL_CONNECTING_MS = 200;
const POLL_CONNECTED_MS = 1000;

// ---- Server transport ----
async function rtc(action, extra = {}) {
  try {
    const res = await fetch("/api/rtc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, id: clientId, ...extra }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn("rtc error", action, err);
    return null;
  }
}

function nextPollDelay() {
  if (!isMatched) return POLL_WAITING_MS;
  const state = peerConnection && peerConnection.connectionState;
  if (state === "connected") return POLL_CONNECTED_MS;
  return POLL_CONNECTING_MS;
}

function schedulePoll(delay) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollOnce, delay != null ? delay : nextPollDelay());
}

let polling = false;
async function pollOnce() {
  if (!started || polling) return;
  polling = true;
  try {
    const res = await rtc("poll");
    if (res) {
      if (res.status === "waiting" && !isMatched) showWaitingRoom(res.waitingCount);
      else if (res.status === "matched") hideWaitingRoom();
      if (Array.isArray(res.messages)) {
        for (const msg of res.messages) {
          await handleServerMessage(msg);
        }
      }
    }
  } finally {
    polling = false;
    schedulePoll();
  }
}

// Trigger an extra poll very soon without disturbing the steady loop.
function pollSoon() {
  schedulePoll(60);
}

function startPolling() {
  clearTimeout(pollTimer);
  pollOnce();
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

// ---- UI helpers ----
function setStatus(state, text) {
  statusEl.className = `status ${state}`;
  statusText.textContent = text;
}

function showWaitingRoom(count) {
  isWaiting = true;
  isMatched = false;
  waitingBanner.hidden = false;
  const n = count || 1;
  waitingText.textContent =
    n === 1
      ? "You're the only one waiting. Hang tight — we'll connect you when someone else joins."
      : `${n} people waiting. You're in the queue — pairing happens two at a time.`;
  setStatus("waiting", "In waiting room");
  setControlsEnabled(false);
  showRemoteOverlay(true, "Waiting for a partner...");
}

function hideWaitingRoom() {
  isWaiting = false;
  waitingBanner.hidden = true;
}

function addSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "system-message";
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addChatMessage(text, type) {
  const div = document.createElement("div");
  div.className = `message ${type}`;
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  div.innerHTML = `${escapeHtml(text)}<span class="time">${time}</span>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function clearChat() {
  chatMessages.innerHTML = "";
}

function setControlsEnabled(matched) {
  chatInput.disabled = !matched;
  sendBtn.disabled = !matched;
  nextBtn.disabled = !matched;
  muteBtn.disabled = !matched;
  cameraBtn.disabled = !matched;
}

function showRemoteOverlay(show, message) {
  remoteOverlay.classList.toggle("hidden", !show);
  if (message) remoteStatus.textContent = message;
}

async function playVideo(el) {
  try {
    await el.play();
  } catch {
    // autoplay policies — user gesture already happened on Start
  }
}

// ---- Media ----
async function getLocalMedia() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: true,
  });
  localVideo.srcObject = localStream;
  await playVideo(localVideo);
  return localStream;
}

// ---- WebRTC serialization ----
function serializeSdp(desc) {
  return { type: desc.type, sdp: desc.sdp };
}

function serializeCandidate(c) {
  return {
    candidate: c.candidate,
    sdpMid: c.sdpMid,
    sdpMLineIndex: c.sdpMLineIndex,
  };
}

async function sendSignal(data) {
  await rtc("signal", { data });
  // Don't reset the main poll timer here (that would starve the receive
  // path while ICE candidates trickle). Just nudge an extra quick poll.
  pollSoon();
}

// ---- WebRTC ----
function createPeerConnection(initiator, mySession) {
  peerConnection = new RTCPeerConnection(ICE_SERVERS);
  pendingCandidates = [];
  remoteDescSet = false;
  makingOffer = false;

  localStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.ontrack = (event) => {
    if (mySession !== sessionId) return;
    const stream = event.streams[0] || new MediaStream([event.track]);
    remoteVideo.srcObject = stream;
    playVideo(remoteVideo);
    showRemoteOverlay(false);
  };

  peerConnection.onicecandidate = (event) => {
    if (mySession !== sessionId) return;
    if (event.candidate) {
      sendSignal({ type: "ice", candidate: serializeCandidate(event.candidate) });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    if (mySession !== sessionId || !peerConnection) return;
    const state = peerConnection.connectionState;
    if (state === "connected") {
      iceRestartTries = 0;
      showRemoteOverlay(false);
    } else if (state === "failed") {
      tryIceRestart(mySession);
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    if (mySession !== sessionId || !peerConnection) return;
    const s = peerConnection.iceConnectionState;
    if (s === "connected" || s === "completed") {
      iceRestartTries = 0;
      showRemoteOverlay(false);
    } else if (s === "failed") {
      tryIceRestart(mySession);
    }
  };

  return peerConnection;
}

async function tryIceRestart(mySession) {
  if (mySession !== sessionId || !peerConnection) return;
  if (!isInitiator) return; // only one side restarts to avoid glare
  if (iceRestartTries >= 2) {
    showRemoteOverlay(true, "Video connection failed — chat still works");
    return;
  }
  iceRestartTries += 1;
  try {
    const offer = await peerConnection.createOffer({ iceRestart: true });
    await peerConnection.setLocalDescription(offer);
    await sendSignal({ type: "offer", sdp: serializeSdp(offer) });
  } catch (err) {
    console.warn("ICE restart failed:", err);
  }
}

function cleanupPeerConnection() {
  sessionId += 1;
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.oniceconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }
  remoteVideo.srcObject = null;
  pendingCandidates = [];
  remoteDescSet = false;
  makingOffer = false;
}

async function flushCandidates() {
  if (!peerConnection) return;
  for (const c of pendingCandidates) {
    try {
      await peerConnection.addIceCandidate(c);
    } catch (err) {
      console.warn("ICE add error:", err);
    }
  }
  pendingCandidates = [];
}

async function handleSignal(data, mySession) {
  if (!peerConnection || mySession !== sessionId || !data) return;

  try {
    if (data.type === "offer") {
      const state = peerConnection.signalingState;
      // Accept an offer when stable (initial) or as an ICE-restart offer.
      // Ignore if we're mid-negotiation in a conflicting state.
      if (state !== "stable" && state !== "have-remote-offer") {
        return;
      }
      await peerConnection.setRemoteDescription(data.sdp);
      remoteDescSet = true;
      await flushCandidates();
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      await sendSignal({ type: "answer", sdp: serializeSdp(answer) });
    } else if (data.type === "answer") {
      // Only valid right after we sent an offer. Drop duplicates/stale.
      if (peerConnection.signalingState !== "have-local-offer") {
        return;
      }
      await peerConnection.setRemoteDescription(data.sdp);
      remoteDescSet = true;
      await flushCandidates();
    } else if (data.type === "ice" && data.candidate) {
      const cand = data.candidate;
      if (remoteDescSet && peerConnection.remoteDescription) {
        try {
          await peerConnection.addIceCandidate(cand);
        } catch (err) {
          console.warn("ICE add error:", err);
        }
      } else {
        pendingCandidates.push(cand);
      }
    }
  } catch (err) {
    console.warn("handleSignal error:", data.type, err);
  }
}

async function startAsInitiator(mySession) {
  createPeerConnection(true, mySession);
  makingOffer = true;
  const offer = await peerConnection.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  await peerConnection.setLocalDescription(offer);
  await sendSignal({ type: "offer", sdp: serializeSdp(offer) });
  makingOffer = false;
}

let isConnecting = false;

async function onMatched(initiator) {
  if (isConnecting || (isMatched && peerConnection)) return;
  isConnecting = true;
  try {
    cleanupPeerConnection();
    const mySession = ++sessionId;
    isInitiator = !!initiator;
    iceRestartTries = 0;

    hideWaitingRoom();
    isMatched = true;
    isWaiting = false;
    setStatus("matched", "Connected to a stranger");
    setControlsEnabled(true);
    clearChat();
    addSystemMessage("You're now chatting with a random stranger. Say hi!");
    showRemoteOverlay(true, "Connecting video...");

    if (initiator) {
      await startAsInitiator(mySession);
    } else {
      createPeerConnection(false, mySession);
    }
    pollSoon();
  } finally {
    isConnecting = false;
  }
}

async function handleServerMessage(msg) {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case "matched":
      await onMatched(msg.initiator);
      break;
    case "waiting":
      showWaitingRoom(msg.waitingCount || msg.position || 1);
      break;
    case "signal":
      await handleSignal(msg.data, sessionId);
      break;
    case "typing":
      typingIndicator.hidden = !msg.value;
      break;
    case "chat":
      addChatMessage(msg.text, "received");
      typingIndicator.hidden = true;
      break;
    case "partner-left":
      cleanupPeerConnection();
      isMatched = false;
      isConnecting = false;
      isInitiator = false;
      setControlsEnabled(false);
      addSystemMessage("Stranger has disconnected.");
      showWaitingRoom(1);
      showRemoteOverlay(true, "Partner left — finding someone new...");
      // The poll loop will re-matchmake automatically; nudge it to be quick.
      pollSoon();
      break;
  }
}

async function startChat() {
  if (started) return;
  try {
    await getLocalMedia();
  } catch (err) {
    console.error("Media error:", err);
    addSystemMessage("Could not access camera/microphone. Check browser permissions.");
    setStatus("error", "Camera/mic denied");
    return;
  }

  started = true;
  startBtn.disabled = true;
  clearChat();
  addSystemMessage("Looking for someone you can chat with...");
  showWaitingRoom(1);
  showRemoteOverlay(true, "Looking for someone...");

  await rtc("join");
  // Always drive everything through the single poll loop. It will deliver the
  // "matched" message (and any signaling) in order, avoiding double-handling.
  startPolling();
}

async function handleNext() {
  cleanupPeerConnection();
  isMatched = false;
  isConnecting = false;
  isInitiator = false;
  setControlsEnabled(false);
  clearChat();
  addSystemMessage("Looking for someone you can chat with...");
  showWaitingRoom(1);
  showRemoteOverlay(true, "Looking for someone...");
  setStatus("waiting", "Searching...");

  await rtc("next");
  // Let the poll loop deliver the next match; nudge it to run promptly.
  pollSoon();
}

function renderNetworkBanner() {
  const host = location.hostname;
  const isLan =
    /^(\d{1,3}\.){3}\d{1,3}$/.test(host) &&
    (host.startsWith("192.168.") || host.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(host));
  if (!isLan) return;
  networkBanner.hidden = false;
  networkUrls.innerHTML = "";
  const url = `${location.protocol}//${location.host}`;
  const span = document.createElement("span");
  span.className = "network-url";
  span.textContent = url;
  span.title = "Click to copy";
  span.addEventListener("click", () => {
    navigator.clipboard.writeText(url);
    span.textContent = "Copied!";
    setTimeout(() => { span.textContent = url; }, 1500);
  });
  networkUrls.appendChild(span);
}

// ---- Events ----
startBtn.addEventListener("click", startChat);
nextBtn.addEventListener("click", handleNext);

muteBtn.addEventListener("click", () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach((t) => { t.enabled = !isMuted; });
  muteBtn.classList.toggle("active", isMuted);
  muteBtn.querySelector(".btn-icon").textContent = isMuted ? "🔇" : "🎤";
});

cameraBtn.addEventListener("click", () => {
  if (!localStream) return;
  isCameraOff = !isCameraOff;
  localStream.getVideoTracks().forEach((t) => { t.enabled = !isCameraOff; });
  cameraBtn.classList.toggle("active", isCameraOff);
  localOverlay.classList.toggle("hidden", !isCameraOff);
  cameraBtn.querySelector(".btn-icon").textContent = isCameraOff ? "📷" : "🎥";
});

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !isMatched) return;

  const res = await rtc("chat", { text });
  if (res?.ok) {
    addChatMessage(text, "sent");
    chatInput.value = "";
  } else {
    addSystemMessage("Message failed to send — try again.");
  }
});

chatInput.addEventListener("input", () => {
  if (!isMatched) return;
  rtc("chat", { text: "__typing__" }).catch(() => {});
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {}, 1000);
});

window.addEventListener("beforeunload", () => {
  stopPolling();
  const payload = JSON.stringify({ action: "leave", id: clientId });
  if (navigator.sendBeacon) {
    navigator.sendBeacon("/api/rtc", new Blob([payload], { type: "application/json" }));
  }
});

setStatus("connected", "Ready");
renderNetworkBanner();
