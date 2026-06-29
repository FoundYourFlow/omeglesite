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
let dataChannel = null;
let pendingCandidates = [];
let remoteDescSet = false;

let isMuted = false;
let isCameraOff = false;
let started = false;
let isMatched = false;
let polling = false;
let typingTimeout = null;

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    // Free public TURN (best-effort) helps connect across different networks.
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
  ],
};

// ---- Server transport (serverless polling) ----
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

// ---- UI helpers ----
function setStatus(state, text) {
  statusEl.className = `status ${state}`;
  statusText.textContent = text;
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

// ---- Media ----
async function getLocalMedia() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
    });
    localVideo.srcObject = localStream;
    return localStream;
  } catch (err) {
    console.error("Media error:", err);
    addSystemMessage("Could not access camera/microphone. Check browser permissions.");
    setStatus("error", "Camera/mic denied");
    throw err;
  }
}

// ---- WebRTC ----
function createPeerConnection(initiator) {
  peerConnection = new RTCPeerConnection(ICE_SERVERS);
  pendingCandidates = [];
  remoteDescSet = false;

  localStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    showRemoteOverlay(false);
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      rtc("signal", { data: { type: "ice", candidate: event.candidate } });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection && peerConnection.connectionState;
    if (state === "connected") {
      showRemoteOverlay(false);
    } else if (state === "failed") {
      showRemoteOverlay(true, "Connection failed");
    }
  };

  if (initiator) {
    setupDataChannel(peerConnection.createDataChannel("chat"));
  } else {
    peerConnection.ondatachannel = (event) => setupDataChannel(event.channel);
  }

  return peerConnection;
}

function setupDataChannel(channel) {
  dataChannel = channel;
  channel.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.kind === "chat") {
      addChatMessage(msg.text, "received");
      typingIndicator.hidden = true;
    } else if (msg.kind === "typing") {
      typingIndicator.hidden = !msg.value;
    }
  };
}

function sendOverChannel(obj) {
  if (dataChannel && dataChannel.readyState === "open") {
    dataChannel.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function cleanupPeerConnection() {
  if (dataChannel) {
    try { dataChannel.close(); } catch {}
    dataChannel = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  remoteVideo.srcObject = null;
  pendingCandidates = [];
  remoteDescSet = false;
}

async function startAsInitiator() {
  createPeerConnection(true);
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  rtc("signal", { data: { type: "offer", sdp: offer } });
}

async function flushCandidates() {
  for (const c of pendingCandidates) {
    try {
      await peerConnection.addIceCandidate(c);
    } catch (err) {
      console.warn("ICE add error:", err);
    }
  }
  pendingCandidates = [];
}

async function handleSignal(data) {
  if (!peerConnection || !data) return;

  if (data.type === "offer") {
    await peerConnection.setRemoteDescription(data.sdp);
    remoteDescSet = true;
    await flushCandidates();
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    rtc("signal", { data: { type: "answer", sdp: answer } });
  } else if (data.type === "answer") {
    await peerConnection.setRemoteDescription(data.sdp);
    remoteDescSet = true;
    await flushCandidates();
  } else if (data.type === "ice" && data.candidate) {
    if (remoteDescSet) {
      try {
        await peerConnection.addIceCandidate(data.candidate);
      } catch (err) {
        console.warn("ICE add error:", err);
      }
    } else {
      pendingCandidates.push(data.candidate);
    }
  }
}

// ---- Matchmaking + polling loop ----
async function pollLoop() {
  if (polling) return;
  polling = true;
  while (polling) {
    const res = await rtc("poll");
    if (res && Array.isArray(res.messages)) {
      for (const msg of res.messages) {
        await handleServerMessage(msg);
      }
    }
    await sleep(1200);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function handleServerMessage(msg) {
  if (!msg || !msg.type) return;

  if (msg.type === "matched") {
    isMatched = true;
    setStatus("matched", "Connected to a stranger");
    setControlsEnabled(true);
    clearChat();
    addSystemMessage("You're now connected! Say hello.");
    showRemoteOverlay(true, "Connecting video...");
    cleanupPeerConnection();
    if (msg.initiator) {
      await startAsInitiator();
    } else {
      createPeerConnection(false);
    }
  } else if (msg.type === "signal") {
    await handleSignal(msg.data);
  } else if (msg.type === "partner-left") {
    if (!isMatched && !started) return;
    cleanupPeerConnection();
    isMatched = false;
    setControlsEnabled(false);
    addSystemMessage("Stranger disconnected. Finding someone new...");
    setStatus("waiting", "Searching...");
    showRemoteOverlay(true, "Finding someone new...");
    await rtc("join");
  }
}

async function startChat() {
  if (started) return;
  try {
    await getLocalMedia();
  } catch {
    return;
  }
  started = true;
  startBtn.disabled = true;
  clearChat();
  addSystemMessage("Looking for someone to chat with...");
  setStatus("waiting", "Searching...");
  showRemoteOverlay(true, "Looking for someone...");
  await rtc("join");
  pollLoop();
}

async function handleNext() {
  cleanupPeerConnection();
  isMatched = false;
  setControlsEnabled(false);
  clearChat();
  addSystemMessage("Finding a new person...");
  setStatus("waiting", "Searching...");
  showRemoteOverlay(true, "Looking for someone...");
  await rtc("next");
}

// ---- Network banner (shown only when serving over a LAN address) ----
function renderNetworkBanner() {
  const host = location.hostname;
  const isLan =
    /^(\d{1,3}\.){3}\d{1,3}$/.test(host) &&
    (host.startsWith("192.168.") || host.startsWith("10.") || host.startsWith("172."));
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

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !isMatched) return;
  if (sendOverChannel({ kind: "chat", text })) {
    addChatMessage(text, "sent");
    chatInput.value = "";
  }
});

chatInput.addEventListener("input", () => {
  if (!isMatched) return;
  sendOverChannel({ kind: "typing", value: true });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => sendOverChannel({ kind: "typing", value: false }), 1000);
});

window.addEventListener("beforeunload", () => {
  const payload = JSON.stringify({ action: "leave", id: clientId });
  if (navigator.sendBeacon) {
    navigator.sendBeacon("/api/rtc", new Blob([payload], { type: "application/json" }));
  }
});

setStatus("connected", "Ready");
renderNetworkBanner();
