// ============================================================
// MeetSpace Room
// ============================================================

const roomId = window.location.pathname.split("/").pop().toUpperCase();
let displayName = "";
let socket;
let localStream;

// Map<socketId, { pc: RTCPeerConnection, stream: MediaStream }>
const peers = new Map();

// Track participant names separately (before we have peer connections)
const participantNames = new Map();

// DOM refs
const videoGrid = document.getElementById("video-grid");
const emptyState = document.getElementById("empty-state");
const chatPanel = document.getElementById("chat-panel");
const chatCloseBtn = document.getElementById("chat-close");
const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send");
const peoplePanel = document.getElementById("people-panel");
const peopleCloseBtn = document.getElementById("people-close");
const participantsList = document.getElementById("participants-list");
const headerRoomId = document.getElementById("header-room-id");
const headerPeers = document.getElementById("header-peers");
const headerConnection = document.getElementById("header-connection");
const recBadge = document.getElementById("rec-badge");
const nameModal = document.getElementById("name-modal");
const roomContainer = document.getElementById("room-container");
const shareCode = document.getElementById("share-code");

// Controls
const btnMic = document.getElementById("btn-mic");
const btnCam = document.getElementById("btn-cam");
const btnScreen = document.getElementById("btn-screen");
const btnHand = document.getElementById("btn-hand");
const btnChat = document.getElementById("btn-chat");
const btnPeople = document.getElementById("btn-people");
const btnRecord = document.getElementById("btn-record");
const copyRoomLink = document.getElementById("copy-room-link");
const shareCopy = document.getElementById("share-copy");
const leaveBtn = document.getElementById("leave-btn");

// State
let isMicOn = true;
let isCamOn = true;
let isHandRaised = false;
let isScreenSharing = false;
let displayStream = null; // keep reference to stop it later
let isRecording = false;

const recorder = new RecordingManager();

// ============================================================
// Init
// ============================================================

async function init() {
  headerRoomId.textContent = roomId;
  shareCode.textContent = roomId;

  // Check URL params for name (password still required via modal)
  const params = new URLSearchParams(window.location.search);
  const nameParam = params.get("name");

  if (nameParam) {
    displayName = nameParam;
    // Still show modal for password
    nameModal.classList.remove("hidden");
    document.getElementById("modal-name-input").value = nameParam;
    document.getElementById("modal-password-input").focus();
  } else {
    nameModal.classList.remove("hidden");
    document.getElementById("modal-name-input").focus();
  }
}

document.getElementById("modal-join-btn").addEventListener("click", async () => {
  const input = document.getElementById("modal-name-input").value.trim();
  const password = document.getElementById("modal-password-input").value;
  if (!input) {
    const err = document.getElementById("modal-error");
    err.textContent = "Please enter your name";
    err.classList.remove("hidden");
    return;
  }
  if (!password) {
    const err = document.getElementById("modal-error");
    err.textContent = "Please enter the meeting password";
    err.classList.remove("hidden");
    return;
  }
  displayName = input;
  await startMeeting(password);
});

document.getElementById("modal-name-input").addEventListener("keydown", async (e) => {
  if (e.key === "Enter") {
    document.getElementById("modal-join-btn").click();
  }
});

document.getElementById("modal-password-input").addEventListener("keydown", async (e) => {
  if (e.key === "Enter") {
    document.getElementById("modal-join-btn").click();
  }
});

async function startMeeting(password) {
  nameModal.classList.add("hidden");
  roomContainer.classList.remove("hidden");

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    if (err.name === "NotAllowedError" || err.name === "NotFoundError") {
      const errEl = document.getElementById("modal-error");
      errEl.textContent = "Camera/mic access was denied. Please click the lock icon in your browser's address bar, allow camera and microphone, then reload.";
      errEl.classList.remove("hidden");
      errEl.style.whiteSpace = "normal";
      nameModal.classList.remove("hidden");
      document.getElementById("modal-password-input").focus();
      roomContainer.classList.add("hidden");
      return;
    }
    localStream = null;
  }

  setupSocket(password);
  setupLocalVideo();
  updateTitle();
}

// ============================================================
// Socket
// ============================================================

function setupSocket(password) {
  socket = io();

  socket.on("connect", () => {
    socket.emit("join-room", { roomId, name: displayName, password });
    headerConnection.textContent = "Connected";
    headerConnection.style.color = "#3ecf8e";
  });

  socket.on("join-error", (message) => {
    nameModal.classList.remove("hidden");
    roomContainer.classList.add("hidden");
    const err = document.getElementById("modal-error");
    err.textContent = message;
    err.classList.remove("hidden");
  });

  socket.on("room-peers", async (peerIds) => {
    for (const peerId of peerIds) {
      await createOfferToPeer(peerId);
    }
  });

  socket.on("peer-joined", ({ socketId, name }) => {
    // Store name for display
    participantNames.set(socketId, name);
    // Wait for them to send an offer
  });

  socket.on("offer", async ({ offer, senderId }) => {
    participantNames.set(senderId, participantNames.get(senderId) || "Participant");
    await handleIncomingOffer(offer, senderId);
  });

  socket.on("answer", async ({ answer, senderId }) => {
    await handleIncomingAnswer(answer, senderId);
  });

  socket.on("ice-candidate", async ({ candidate, senderId }) => {
    const peerData = peers.get(senderId);
    if (peerData && peerData.pc.remoteDescription) {
      try {
        await peerData.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        // stale/bad candidate
      }
    }
  });

  socket.on("chat-message", ({ text, name, timestamp }) => {
    appendChatMessage(name, text, timestamp);
  });

  socket.on("media-state", ({ socketId, micOn, camOn }) => {
    updateRemoteTileIcons(socketId, micOn, camOn);
    updateParticipantsPanel();
  });

  socket.on("raise-hand", ({ socketId, raised }) => {
    toggleRemoteHand(socketId, raised);
    updateParticipantsPanel();
  });

  socket.on("screenshare-update", ({ socketId, isScreenSharing }) => {
    console.log("Peer", socketId, "screen share:", isScreenSharing);
    const tile = document.getElementById("tile-" + socketId);
    if (!tile) return;

    // Force video element to re-render with updated track
    const video = tile.querySelector("video");
    if (!video) return;

    const currentStream = video.srcObject;
    if (currentStream) {
      // Replace video element entirely to force refresh
      const newVideo = document.createElement("video");
      newVideo.setAttribute("autoplay", "");
      newVideo.setAttribute("playsinline", "");
      newVideo.srcObject = currentStream;
      video.replaceWith(newVideo);
      newVideo.play().catch(() => {});

      if (isScreenSharing) {
        newVideo.classList.add("screen-share");
      } else {
        newVideo.classList.remove("screen-share");
      }
    }
  });

  socket.on("participants-update", (participants) => {
    // Update participant info map
    for (const p of participants) {
      participantNames.set(p.socketId, p.name);
    }
    const others = participants.filter((p) => p.socketId !== socket.id);
    const count = others.length;
    headerPeers.textContent = count > 0 ? `${count} participant${count > 1 ? "s" : ""}` : "";

    if (count === 0) {
      emptyState.classList.remove("hidden");
    } else {
      emptyState.classList.add("hidden");
    }

    updateGridLayout(count + 1); // +1 for local
    updateParticipantsPanel();
  });

  socket.on("disconnect", () => {
    headerConnection.textContent = "Disconnected";
    headerConnection.style.color = "#e05252";
    for (const [sid, data] of [...peers]) {
      removePeerTile(sid);
      data.pc.close();
      peers.delete(sid);
    }
  });
}

// ============================================================
// WebRTC
// ============================================================

function getIceServers() {
  return {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  };
}

function getLocalTracks() {
  if (localStream && localStream.getTracks().length > 0) return localStream;
  // No media — create an empty stream so the PC can still connect
  return new MediaStream();
}

async function createPeerConnection() {
  const pc = new RTCPeerConnection(getIceServers());
  const stream = getLocalTracks();

  stream.getTracks().forEach((track) => {
    if (track.readyState === "live") {
      pc.addTrack(track, stream);
    }
  });

  return pc;
}

async function createOfferToPeer(peerId) {
  // Don't duplicate
  if (peers.has(peerId)) {
    const existing = peers.get(peerId);
    if (existing.pc.signalingState !== "closed") return;
  }

  const pc = await createPeerConnection();

  // ICE forwarding
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("ice-candidate", { targetId: peerId, candidate: e.candidate });
    }
  };

  // Connection state
  pc.onconnectionstatechange = () => {
    updateTileConnection(peerId, pc.connectionState);
  };

  // Incoming tracks
  pc.ontrack = (e) => {
    console.log("ontrack for", peerId, "kind:", e.track.kind, "state:", e.track.readyState);
    const stream = e.streams && e.streams[0];
    if (stream) {
      const data = peers.get(peerId);
      if (data) {
        data.stream = stream;
        renderRemoteVideo(peerId, stream);
      }
    }
  };

  peers.set(peerId, { pc, stream: null });

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("offer", { targetId: peerId, offer });
  } catch (e) {
    console.error("createOffer failed:", e);
  }
}

async function handleIncomingOffer(offer, senderId) {
  // If we already have a PC for this peer (from our side), close it to avoid duplicate connections
  if (peers.has(senderId)) {
    const existing = peers.get(senderId);
    if (existing.pc.signalingState !== "closed") {
      existing.pc.close();
    }
    peers.delete(senderId);
  }

  const pc = await createPeerConnection();

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("ice-candidate", { targetId: senderId, candidate: e.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    updateTileConnection(senderId, pc.connectionState);
  };

  pc.ontrack = (e) => {
    console.log("ontrack for", senderId, "kind:", e.track.kind, "state:", e.track.readyState);
    const stream = e.streams && e.streams[0];
    if (stream) {
      const data = peers.get(senderId);
      if (data) {
        data.stream = stream;
        renderRemoteVideo(senderId, stream);
      }
    }
  };

  peers.set(senderId, { pc, stream: null });

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("answer", { targetId: senderId, answer });
  } catch (e) {
    console.error("handleOffer failed:", e);
  }
}

async function handleIncomingAnswer(answer, senderId) {
  const peerData = peers.get(senderId);
  if (peerData && peerData.pc.signalingState !== "closed") {
    try {
      await peerData.pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (e) {
      console.error("handleAnswer failed:", e);
    }
  }
}

// ============================================================
// Local Video Tile
// ============================================================

function setupLocalVideo() {
  const existing = document.getElementById("tile-local");
  if (existing) existing.remove();

  const tile = document.createElement("div");
  tile.className = "video-tile";
  tile.id = "tile-local";

  if (localStream && isCamOn) {
    const video = document.createElement("video");
    video.setAttribute("autoplay", "");
    video.setAttribute("playsinline", "");
    video.muted = true;
    video.srcObject = localStream;
    tile.appendChild(video);
    video.play().catch(() => {});
  } else {
    const initials = document.createElement("div");
    initials.className = "tile-avatar";
    initials.textContent = initialsFor(displayName);
    tile.appendChild(initials);
  }

  // Overlay
  const overlay = document.createElement("div");
  overlay.className = "tile-overlay";

  const nameEl = document.createElement("span");
  nameEl.className = "tile-name";
  nameEl.textContent = displayName + " (You)";
  overlay.appendChild(nameEl);

  const icons = document.createElement("div");
  icons.className = "tile-icons";

  const micIcon = document.createElement("div");
  micIcon.className = "tile-icon" + (!isMicOn ? " muted" : "");
  micIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0"/></svg>`;
  icons.appendChild(micIcon);

  overlay.appendChild(icons);
  tile.appendChild(overlay);

  videoGrid.appendChild(tile);
}

function updateLocalVideo() {
  const tile = document.getElementById("tile-local");
  if (!tile) return;

  const existingVideo = tile.querySelector("video");
  const existingAvatar = tile.querySelector(".tile-avatar");

  if (isCamOn && localStream) {
    if (!existingVideo) {
      if (existingAvatar) existingAvatar.remove();
      const video = document.createElement("video");
      video.setAttribute("autoplay", "");
      video.setAttribute("playsinline", "");
      video.muted = true;
      video.srcObject = localStream;
      tile.insertBefore(video, tile.querySelector(".tile-overlay"));
      video.play().catch(() => {});
    } else {
      existingVideo.srcObject = localStream;
    }
  } else {
    if (existingVideo) {
      existingVideo.srcObject = null;
      existingVideo.remove();
    }
    if (!existingAvatar) {
      const initials = document.createElement("div");
      initials.className = "tile-avatar";
      initials.textContent = initialsFor(displayName);
      tile.insertBefore(initials, tile.querySelector(".tile-overlay"));
    }
  }

  // Update mic icon
  const micIcon = tile.querySelector(".tile-icon");
  if (micIcon) {
    micIcon.className = "tile-icon" + (!isMicOn ? " muted" : "");
  }
}

// ============================================================
// Remote Video Tiles
// ============================================================

function renderRemoteVideo(socketId, stream) {
  let tile = document.getElementById("tile-" + socketId);
  if (tile) {
    const video = tile.querySelector("video");
    if (video) {
      video.srcObject = stream;
      video.play().catch(() => {});
      return;
    }
  }

  tile = document.createElement("div");
  tile.className = "video-tile";
  tile.id = "tile-" + socketId;

  const video = document.createElement("video");
  video.setAttribute("autoplay", "");
  video.setAttribute("playsinline", "");
  video.srcObject = stream;
  video.muted = false;
  tile.appendChild(video);

  video.play().catch(() => {});

  const overlay = document.createElement("div");
  overlay.className = "tile-overlay";

  const nameEl = document.createElement("span");
  nameEl.className = "tile-name";
  nameEl.id = "tile-name-" + socketId;
  nameEl.textContent = participantNames.get(socketId) || "Participant";
  overlay.appendChild(nameEl);

  const icons = document.createElement("div");
  icons.className = "tile-icons";

  const micIcon = document.createElement("div");
  micIcon.className = "tile-icon";
  micIcon.id = "mic-icon-" + socketId;
  micIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0"/></svg>`;
  icons.appendChild(micIcon);

  const camIcon = document.createElement("div");
  camIcon.className = "tile-icon";
  camIcon.id = "cam-icon-" + socketId;
  camIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2" fill="none"/></svg>`;
  icons.appendChild(camIcon);

  overlay.appendChild(icons);
  tile.appendChild(overlay);

  // Connecting indicator
  const conn = document.createElement("div");
  conn.className = "tile-connection";
  conn.id = "tile-conn-" + socketId;
  conn.textContent = "Connecting…";
  tile.appendChild(conn);

  videoGrid.appendChild(tile);
  updateLayout();
}

function updateRemoteTileIcons(socketId, micOn, camOn) {
  const micEl = document.getElementById("mic-icon-" + socketId);
  if (micEl) micEl.className = "tile-icon" + (!micOn ? " muted" : "");

  const camEl = document.getElementById("cam-icon-" + socketId);
  if (camEl) camEl.className = "tile-icon" + (!camOn ? " muted" : "");
}

function toggleRemoteHand(socketId, raised) {
  const tile = document.getElementById("tile-" + socketId);
  if (!tile) return;
  const existing = tile.querySelector(".hand-badge");
  if (raised && !existing) {
    const badge = document.createElement("div");
    badge.className = "hand-badge";
    badge.textContent = "\u270B";
    tile.appendChild(badge);
  } else if (!raised && existing) {
    existing.remove();
  }
}

function updateTileConnection(socketId, state) {
  const connEl = document.getElementById("tile-conn-" + socketId);
  if (!connEl) return;
  if (state === "connected" || state === "completed") {
    connEl.remove();
  } else if (state === "disconnected" || state === "failed") {
    connEl.textContent = "Reconnecting…";
    connEl.style.color = "#e05252";
  } else {
    connEl.textContent = "Connecting…";
  }
}

function removePeerTile(socketId) {
  const tile = document.getElementById("tile-" + socketId);
  if (tile) {
    tile.style.transition = "opacity 0.2s, transform 0.2s";
    tile.style.opacity = "0";
    tile.style.transform = "scale(0.9)";
    setTimeout(() => {
      tile.remove();
      updateLayout();
    }, 200);
  }
}

// ============================================================
// Layout
// ============================================================

function updateLayout() {
  const count = videoGrid.querySelectorAll(".video-tile").length;
  updateGridLayout(count);
}

function updateGridLayout(count) {
  if (count <= 0) count = 1;
  if (count > 6) count = 6;
  videoGrid.className = "video-grid";
  videoGrid.classList.add("layout-" + count);
}

// ============================================================
// Participants Panel
// ============================================================

function updateParticipantsPanel() {
  if (peoplePanel.classList.contains("hidden")) return;
  renderParticipantsPanel();
}

function renderParticipantsPanel() {
  participantsList.innerHTML = "";

  // Local participant
  addParticipantRow(displayName, true, isMicOn, isCamOn, isHandRaised);

  // Remote participants from name map + peers data
  for (const [sid] of peers) {
    const name = participantNames.get(sid) || "Participant";
    addParticipantRow(name, false, true, true, false); // approximate — actual state from server
  }

  // Also list from participants-update (non-peer entries)
  if (!socket) return;
}

function addParticipantRow(name, isLocal, micOn, camOn, handRaised) {
  const row = document.createElement("div");
  row.className = "participant-row";

  const avatar = document.createElement("div");
  avatar.className = "participant-avatar-sm";
  avatar.textContent = initialsFor(name);

  const info = document.createElement("div");
  info.className = "participant-info";

  const pname = document.createElement("div");
  pname.className = "pname";
  pname.textContent = isLocal ? name + " (You)" : name;

  const icons = document.createElement("div");
  icons.className = "participant-icons";

  const piMic = document.createElement("div");
  piMic.className = "pi" + (!micOn ? " off" : "");
  piMic.innerHTML = micOn
    ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0"/></svg>`
    : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6"/><path d="M17 16.95A7 7 0 015 12v-2"/></svg>`;

  const piCam = document.createElement("div");
  piCam.className = "pi" + (!camOn ? " off" : "");
  piCam.innerHTML = camOn
    ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`
    : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l22 22M10.66 5.38L8.44 5C7.12 4.78 5.57 5.44 5.57 7.18V16.64c0 1.74 1.55 2.4 2.87 2.18l2.22-.38"/><line x1="23" y1="7" x2="16" y2="12"/></svg>`;

  icons.appendChild(piMic);
  icons.appendChild(piCam);
  info.appendChild(pname);
  info.appendChild(icons);
  row.appendChild(avatar);
  row.appendChild(info);

  if (handRaised) {
    const handEl = document.createElement("span");
    handEl.textContent = "\u270B";
    handEl.style.marginLeft = "0.25rem";
    handEl.style.fontSize = "1rem";
    info.appendChild(handEl);
  }

  participantsList.appendChild(row);
}

// ============================================================
// Chat
// ============================================================

function appendChatMessage(name, text, time) {
  const div = document.createElement("div");
  div.className = "chat-msg";

  const sender = document.createElement("div");
  sender.className = "chat-sender";
  sender.textContent = name;

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.textContent = text;

  const timeEl = document.createElement("div");
  timeEl.className = "chat-time";
  timeEl.textContent = time;

  div.appendChild(sender);
  div.appendChild(bubble);
  div.appendChild(timeEl);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function closeAllPanels() {
  chatPanel.classList.add("hidden");
  peoplePanel.classList.add("hidden");
  document.querySelectorAll(".panel-overlay").forEach((el) => el.remove());
}

function toggleChatPanel() {
  if (chatPanel.classList.contains("hidden")) {
    closeAllPanels();
    chatPanel.classList.remove("hidden");
    const overlay = document.createElement("div");
    overlay.className = "panel-overlay";
    overlay.onclick = closeAllPanels;
    document.body.appendChild(overlay);
    chatInput.focus();
  } else {
    closeAllPanels();
  }
}

function togglePeoplePanel() {
  if (peoplePanel.classList.contains("hidden")) {
    closeAllPanels();
    updateParticipantsPanel();
    peoplePanel.classList.remove("hidden");
    const overlay = document.createElement("div");
    overlay.className = "panel-overlay";
    overlay.onclick = closeAllPanels;
    document.body.appendChild(overlay);
  } else {
    closeAllPanels();
  }
}

// ============================================================
// Controls
// ============================================================

function toggleMic() {
  isMicOn = !isMicOn;

  const iconOn = btnMic.querySelector(".icon-mic");
  const iconOff = btnMic.querySelector(".icon-mic-off");
  iconOn.classList.toggle("hidden", !isMicOn);
  iconOff.classList.toggle("hidden", isMicOn);
  btnMic.classList.toggle("muted", !isMicOn);

  if (localStream) {
    localStream.getAudioTracks().forEach((t) => (t.enabled = isMicOn));
  }
  for (const [, data] of peers) {
    for (const sender of data.pc.getSenders()) {
      if (sender.track && sender.track.kind === "audio") {
        sender.track.enabled = isMicOn;
      }
    }
  }

  socket.emit("media-state", { roomId, micOn: isMicOn, camOn: isCamOn });
}

function toggleCamera() {
  if (isCamOn) {
    isCamOn = false;
    if (localStream) {
      localStream.getVideoTracks().forEach((t) => (t.enabled = false));
    }
    for (const [, data] of peers) {
      for (const sender of data.pc.getSenders()) {
        if (sender.track && sender.track.kind === "video") {
          sender.track.enabled = false;
        }
      }
    }
    updateLocalVideo();
  } else {
    navigator.mediaDevices
      .getUserMedia({ video: true })
      .then((stream) => {
        const videoTrack = stream.getVideoTracks()[0];
        if (localStream) {
          localStream.addTrack(videoTrack);
        } else {
          // Create a new stream with just video
          localStream = stream;
        }
        isCamOn = true;
        updateLocalVideo();

        for (const [, data] of peers) {
          for (const sender of data.pc.getSenders()) {
            if (sender.track && sender.track.kind === "video") {
              sender.replaceTrack(videoTrack);
            }
          }
        }
      })
      .catch(() => {});
  }

  const iconOn = btnCam.querySelector(".icon-cam");
  const iconOff = btnCam.querySelector(".icon-cam-off");
  iconOn.classList.toggle("hidden", !isCamOn);
  iconOff.classList.toggle("hidden", isCamOn);
  btnCam.classList.toggle("muted", !isCamOn);

  socket.emit("media-state", { roomId, micOn: isMicOn, camOn: isCamOn });
}

async function toggleScreenShare() {
  if (!isScreenSharing) {
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });

      const screenVideoTrack = displayStream.getVideoTracks()[0];
      isScreenSharing = true;
      btnScreen.classList.add("screen-active");

      console.log("Screen share started, replacing tracks on", peers.size, "peer(s)");

      // Replace video track on all peer connections
      for (const [peerId, data] of peers) {
        const senders = data.pc.getSenders();
        for (const sender of senders) {
          if (sender.track && sender.track.kind === "video") {
            try {
              await sender.replaceTrack(screenVideoTrack);
              console.log("Replaced video track for peer", peerId);
            } catch (e) {
              console.error("Failed to replace track for", peerId, e);
            }
          }
        }
      }

      // Update local tile to show screen content
      const localTile = document.getElementById("tile-local");
      if (localTile) {
        const existingVideo = localTile.querySelector("video");
        if (existingVideo) {
          existingVideo.srcObject = displayStream;
          existingVideo.classList.add("screen-share");
        }
      }

      // Notify peers to refresh their video elements
      socket.emit("screenshare-update", { roomId, isScreenSharing: true });
      if (localStream) {
        localStream.getVideoTracks().forEach((t) => (t.enabled = false));
      }

      // Handle native stop (user clicks browser "Stop sharing" button)
      screenVideoTrack.onended = () => {
        stopScreenShare();
      };

      const audioTrack = displayStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.onended = () => {
          stopScreenShare();
        };
      }
    } catch (e) {
      // User cancelled screen share picker
      console.log("Screen share cancelled:", e);
    }
  } else {
    stopScreenShare();
  }
}

function stopScreenShare() {
  isScreenSharing = false;
  btnScreen.classList.remove("screen-active");

  socket.emit("screenshare-update", { roomId, isScreenSharing: false });

  if (displayStream) {
    displayStream.getTracks().forEach((t) => t.stop());
  }
  displayStream = null;

  if (localStream && localStream.getVideoTracks().length > 0) {
    const camTrack = localStream.getVideoTracks()[0];
    camTrack.enabled = true;

    for (const [, data] of peers) {
      for (const sender of data.pc.getSenders()) {
        if (sender.track && sender.track.kind === "video") {
          sender.replaceTrack(camTrack);
        }
      }
    }
  }

  // Restore local tile to camera
  const localTile = document.getElementById("tile-local");
  if (localTile && localStream) {
    const video = localTile.querySelector("video");
    if (video) {
      video.srcObject = localStream;
      video.classList.remove("screen-share");
    }
  }
}

function toggleHand() {
  isHandRaised = !isHandRaised;
  btnHand.classList.toggle("active", isHandRaised);

  const tile = document.getElementById("tile-local");
  if (tile) {
    const existing = tile.querySelector(".hand-badge");
    if (isHandRaised && !existing) {
      const badge = document.createElement("div");
      badge.className = "hand-badge";
      badge.textContent = "\u270B";
      tile.appendChild(badge);
    } else if (!isHandRaised && existing) {
      existing.remove();
    }
  }

  socket.emit("raise-hand", { roomId, raised: isHandRaised });
}

function startOrStopRecording() {
  if (!isRecording) {
    if (!localStream) return;
    recorder.startRecording(localStream);
    isRecording = true;
    btnRecord.classList.add("screen-active");
    recBadge.classList.remove("hidden");
  } else {
    recorder.stopRecording();
    isRecording = false;
    btnRecord.classList.remove("screen-active");
    recBadge.classList.add("hidden");
  }
}

function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  appendChatMessage(displayName, text, ts); // show locally immediately
  socket.emit("chat-message", { roomId, text, name: displayName });
  chatInput.value = "";
}

function leaveCall() {
  if (!confirm("Leave this meeting?")) return;

  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  for (const [, data] of peers) data.pc.close();
  if (socket) socket.disconnect();

  window.location.href = "/";
}

// ============================================================
// Helpers
// ============================================================

function initialsFor(name) {
  return name.charAt(0).toUpperCase();
}

function updateTitle() {
  if (!headerPeers) return;
  const text = headerPeers.textContent || "";
  document.title = "MeetSpace \u00B7 " + roomId + (text ? " (" + text + ")" : "");
}

// ============================================================
// Event Bindings
// ============================================================

btnMic.addEventListener("click", toggleMic);
btnCam.addEventListener("click", toggleCamera);
btnScreen.addEventListener("click", toggleScreenShare);
btnHand.addEventListener("click", toggleHand);
btnChat.addEventListener("click", toggleChatPanel);
btnPeople.addEventListener("click", togglePeoplePanel);
btnRecord.addEventListener("click", startOrStopRecording);
leaveBtn.addEventListener("click", leaveCall);

chatSendBtn.addEventListener("click", sendChatMessage);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendChatMessage();
  }
});

chatCloseBtn.addEventListener("click", closeAllPanels);
peopleCloseBtn.addEventListener("click", closeAllPanels);

copyRoomLink.addEventListener("click", () => {
  navigator.clipboard.writeText(window.location.href).catch(() => {});
  copyRoomLink.style.color = "#3ecf8e";
  setTimeout(() => (copyRoomLink.style.color = ""), 1500);
});

shareCopy.addEventListener("click", () => {
  navigator.clipboard.writeText(window.location.href).catch(() => {});
  shareCopy.style.color = "#3ecf8e";
  setTimeout(() => (shareCopy.style.color = ""), 1500);
});

// ============================================================
// Start
// ============================================================

init();
