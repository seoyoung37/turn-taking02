let FaceLandmarker;
let FilesetResolver;

console.log("app.js loaded");

const stage = document.getElementById("stage");
const roomInput = document.getElementById("roomInput");
const muteBtn = document.getElementById("muteBtn");
const cameraBtn = document.getElementById("cameraBtn");
const copyLinkBtn = document.getElementById("copyLinkBtn");
const circleToggleBtn = document.getElementById("circleToggleBtn");

const url = new URL(window.location.href);
const roomId = url.searchParams.get("room") || "studio";

if (roomInput) {
  roomInput.value = roomId;
}

let displayName =
  localStorage.getItem("inbetween-name") ||
  prompt("Your name?") ||
  "Participant";

localStorage.setItem("inbetween-name", displayName);

const socket = io();

let myId = null;
let localStream = null;
let localVideoEl = null;

const participants = new Map();

const peers = new Map();

let audioContext;
let analyser;
let audioData;

let faceLandmarker = null;
let faceScaleBaseline = null;

let activeSpeakerId = null;
let heldSpeakerId = null;

let lastAnySpeakerAt = Date.now();
let noSpeakerMode = false;
let circleModeEnabled = false;
let circleModeEnabledAt = null;
let orbitAngle = 0;

let lastStateSentAt = 0;
let lastSpeakingTick = Date.now();
let hasJoinedRoom = false;

const SPEECH_START_THRESHOLD = 0.018;
const SPEECH_STOP_THRESHOLD = 0.01;
const SPEECH_START_HOLD_MS = 80;
const SPEECH_STOP_HOLD_MS = 700;

const SILENCE_TO_CIRCLE_MS = 5000;
const ACTIVE_SPEAKER_VOLUME = 0.012;

const LIP_GAP_THRESHOLD = 0.045;
const JAW_OPEN_THRESHOLD = 0.22;
const LEAN_FORWARD_SCALE = 1.12;

let speechCandidateSince = null;
let silenceCandidateSince = null;

const localState = {
  muted: false,
  cameraOff: false,
  isSpeaking: false,
  volume: 0,
  lipOpen: false,
  leaning: false,
  gazingSpeaker: false,
  speakingMs: 0,
};

let ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

registerMediaUnlock();
init();

async function loadIceServers() {
  try {
    const response = await fetch("/config");

    if (!response.ok) {
      throw new Error(`Config request failed: ${response.status}`);
    }

    const config = await response.json();

    if (Array.isArray(config.iceServers) && config.iceServers.length > 0) {
      ICE_SERVERS = config.iceServers;
    }

    console.log("ICE servers loaded:", ICE_SERVERS);
  } catch (error) {
    console.warn(
      "Failed to load /config. Using default STUN servers only.",
      error
    );
  }
}

function registerMediaUnlock() {
  const unlock = () => {
    if (audioContext && audioContext.state === "suspended") {
      audioContext.resume().catch((error) => {
        console.warn("audioContext resume failed:", error);
      });
    }

    participants.forEach((participant) => {
      tryPlayVideo(participant.video);
    });
  };

  document.addEventListener("click", unlock);
  document.addEventListener("touchstart", unlock);
  document.addEventListener("keydown", unlock);
}

function tryPlayVideo(video) {
  if (!video) return;

  const promise = video.play();

  if (promise && typeof promise.catch === "function") {
    promise.catch((error) => {
      console.warn("video play blocked or delayed:", error);
    });
  }
}

function joinRoom() {
  if (!socket.connected) return;
  if (hasJoinedRoom) return;

  hasJoinedRoom = true;

  console.log("joining room", roomId);

  socket.emit("join-room", {
    roomId,
    name: displayName,
  });
}

async function init() {
  console.log("init started");

  try {
    await loadIceServers();
    await startLocalMedia();

    console.log("local media ready", localStream);

    setupButtons();

    socket.on("connect", () => {
      console.log("socket connected", socket.id);
      joinRoom();
    });

    socket.on("disconnect", () => {
      console.log("socket disconnected");
      hasJoinedRoom = false;
    });

    socket.on("joined", async ({ id, users }) => {
      console.log("joined room", id, users);
      myId = id;

      addParticipant({
        id: myId,
        name: displayName,
        stream: localStream,
        state: localState,
        isLocal: true,
      });

      for (const user of users) {
        addParticipant({
          id: user.id,
          name: user.name,
          stream: new MediaStream(),
          state: user.state,
          isLocal: false,
        });

        await createOffer(user.id);
      }

      setupAudioAnalyzer();

      setupFaceLandmarker()
        .then(() => {
          console.log("FaceLandmarker ready");
        })
        .catch((error) => {
          console.error("FaceLandmarker failed:", error);
        });

      requestAnimationFrame(loop);
    });

    socket.on("user-joined", ({ id, name, state }) => {
      console.log("user joined:", id, name);

      addParticipant({
        id,
        name,
        stream: new MediaStream(),
        state,
        isLocal: false,
      });
    });

    socket.on("user-left", ({ id }) => {
      console.log("user left:", id);
      removeParticipant(id);
    });

    socket.on("user-state", ({ id, state }) => {
      const participant = participants.get(id);
      if (!participant) return;

      participant.state = {
        ...participant.state,
        ...state,
      };
    });

    socket.on("signal", handleSignal);

    if (socket.connected) {
      joinRoom();
    }
  } catch (error) {
    console.error("Camera/Mic error:", error);

    alert(
      "Camera and microphone permission is needed. Please allow access and refresh."
    );
  }
}

async function startLocalMedia() {
  localStream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: "user",
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}

function setupButtons() {
  if (muteBtn) {
    muteBtn.addEventListener("click", () => {
      const audioTrack = localStream.getAudioTracks()[0];
      if (!audioTrack) return;

      audioTrack.enabled = !audioTrack.enabled;
      localState.muted = !audioTrack.enabled;

      if (localState.muted) {
        localState.isSpeaking = false;
        localState.volume = 0;
        speechCandidateSince = null;
        silenceCandidateSince = null;
      }

      muteBtn.textContent = localState.muted ? "Unmute" : "Mute";
      muteBtn.classList.toggle("secondary", localState.muted);

      sendStateNow();
    });
  }

  if (cameraBtn) {
    cameraBtn.addEventListener("click", () => {
      const videoTrack = localStream.getVideoTracks()[0];
      if (!videoTrack) return;

      videoTrack.enabled = !videoTrack.enabled;
      localState.cameraOff = !videoTrack.enabled;

      cameraBtn.textContent = localState.cameraOff ? "Camera On" : "Camera Off";
      cameraBtn.classList.toggle("secondary", localState.cameraOff);

      sendStateNow();
    });
  }

  if (copyLinkBtn) {
    copyLinkBtn.addEventListener("click", async () => {
      const inviteUrl = `${location.origin}${location.pathname}?room=${encodeURIComponent(
        roomId
      )}`;

      await navigator.clipboard.writeText(inviteUrl);

      copyLinkBtn.textContent = "Copied";

      setTimeout(() => {
        copyLinkBtn.textContent = "Copy Invite Link";
      }, 1200);
    });
  }

  if (circleToggleBtn) {
    circleToggleBtn.addEventListener("click", () => {
      const now = Date.now();

      circleModeEnabled = !circleModeEnabled;
      circleModeEnabledAt = circleModeEnabled ? now : null;

      lastAnySpeakerAt = now;
      noSpeakerMode = false;

      circleToggleBtn.textContent = circleModeEnabled
        ? "Circle Mode On"
        : "Circle Mode Off";

      circleToggleBtn.classList.toggle("secondary", !circleModeEnabled);

      console.log("circleModeEnabled:", circleModeEnabled);

      sendStateNow();
    });
  }
}

async function setupFaceLandmarker() {
  const visionModule = await import(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/+esm"
  );

  FaceLandmarker = visionModule.FaceLandmarker;
  FilesetResolver = visionModule.FilesetResolver;

  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm"
  );

  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
}

function setupAudioAnalyzer() {
  audioContext = new AudioContext();

  const source = audioContext.createMediaStreamSource(localStream);

  analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;

  audioData = new Uint8Array(analyser.fftSize);

  source.connect(analyser);
}

function addParticipant({ id, name, stream, state, isLocal }) {
  if (participants.has(id)) return;

  const tile = document.createElement("section");
  tile.className = "tile";

  if (isLocal) {
    tile.classList.add("local");
  }

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = Boolean(isLocal);
  video.volume = isLocal ? 0 : 1;

  const existingPeer = peers.get(id);

  if (!isLocal && existingPeer?.stream) {
    video.srcObject = existingPeer.stream;
  } else {
    video.srcObject = stream;
  }

  video.addEventListener("loadedmetadata", () => {
    tryPlayVideo(video);
  });

  if (isLocal) {
    localVideoEl = video;
  }

  const nameTag = document.createElement("div");
  nameTag.className = "name";
  nameTag.textContent = isLocal ? `${name} / You` : name;

  const cue = document.createElement("div");
  cue.className = "cue";
  cue.innerHTML = `
    <span class="dot lip-dot" title="Lip parting"></span>
    <span class="dot lean-dot" title="Leaning forward"></span>
    <span class="dot gaze-dot" title="Gazing at speaker"></span>
  `;

  tile.appendChild(video);
  tile.appendChild(nameTag);
  tile.appendChild(cue);

  stage.appendChild(tile);

  participants.set(id, {
    id,
    name,
    stream: video.srcObject || stream,
    tile,
    video,
    state: {
      muted: false,
      cameraOff: false,
      isSpeaking: false,
      volume: 0,
      lipOpen: false,
      leaning: false,
      gazingSpeaker: false,
      speakingMs: 0,
      ...state,
    },
    isLocal,
  });

  tryPlayVideo(video);
}

function removeParticipant(id) {
  const participant = participants.get(id);

  if (participant) {
    participant.tile.remove();
    participants.delete(id);
  }

  const peer = peers.get(id);

  if (peer) {
    peer.pc.close();
    peers.delete(id);
  }

  if (activeSpeakerId === id) {
    activeSpeakerId = null;
  }

  if (heldSpeakerId === id) {
    heldSpeakerId = null;
  }
}

async function createOffer(remoteId) {
  const pc = ensurePeer(remoteId);

  try {
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });

    await pc.setLocalDescription(offer);

    socket.emit("signal", {
      to: remoteId,
      type: "offer",
      sdp: pc.localDescription,
    });

    console.log("offer sent to:", remoteId);
  } catch (error) {
    console.error("createOffer failed:", remoteId, error);
  }
}

function ensurePeer(remoteId) {
  if (peers.has(remoteId)) {
    return peers.get(remoteId).pc;
  }

  const pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
  });

  const remoteStream = new MediaStream();

  peers.set(remoteId, {
    pc,
    stream: remoteStream,
    pendingCandidates: [],
  });

  console.log("peer created:", remoteId, ICE_SERVERS);

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  }

  pc.onconnectionstatechange = () => {
    console.log("peer connection state:", remoteId, pc.connectionState);
  };

  pc.oniceconnectionstatechange = () => {
    console.log("ice connection state:", remoteId, pc.iceConnectionState);
  };

  pc.onsignalingstatechange = () => {
    console.log("signaling state:", remoteId, pc.signalingState);
  };

  pc.onicecandidateerror = (event) => {
    console.warn("ICE candidate error:", {
      remoteId,
      url: event.url,
      errorCode: event.errorCode,
      errorText: event.errorText,
    });
  };

  pc.ontrack = (event) => {
    const incomingTracks =
      event.streams && event.streams[0]
        ? event.streams[0].getTracks()
        : [event.track].filter(Boolean);

    incomingTracks.forEach((track) => {
      const alreadyAdded = remoteStream
        .getTracks()
        .some((existingTrack) => existingTrack.id === track.id);

      if (!alreadyAdded) {
        remoteStream.addTrack(track);
      }
    });

    const participant = participants.get(remoteId);

    if (participant) {
      participant.stream = remoteStream;
      participant.video.srcObject = remoteStream;

      tryPlayVideo(participant.video);
    }

    console.log(
      "remote track received from:",
      remoteId,
      remoteStream.getTracks().map((track) => ({
        kind: track.kind,
        id: track.id,
        enabled: track.enabled,
        readyState: track.readyState,
      }))
    );
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) {
      console.log("ICE gathering complete for:", remoteId);
      return;
    }

    socket.emit("signal", {
      to: remoteId,
      type: "ice",
      candidate: event.candidate,
    });
  };

  return pc;
}

async function handleSignal({ from, type, sdp, candidate }) {
  const pc = ensurePeer(from);

  try {
    if (type === "offer") {
      console.log("offer received from:", from);

      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushPendingIceCandidates(from);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit("signal", {
        to: from,
        type: "answer",
        sdp: pc.localDescription,
      });

      console.log("answer sent to:", from);
      return;
    }

    if (type === "answer") {
      console.log("answer received from:", from);

      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushPendingIceCandidates(from);

      return;
    }

    if (type === "ice" && candidate) {
      await addIceCandidateSafely(from, candidate);
      return;
    }
  } catch (error) {
    console.error("handleSignal error:", {
      from,
      type,
      error,
    });
  }
}

async function addIceCandidateSafely(remoteId, candidate) {
  const peer = peers.get(remoteId);
  if (!peer) return;

  const pc = peer.pc;
  const iceCandidate = new RTCIceCandidate(candidate);

  if (pc.remoteDescription && pc.remoteDescription.type) {
    try {
      await pc.addIceCandidate(iceCandidate);
    } catch (error) {
      console.warn("addIceCandidate failed:", remoteId, error);
    }
  } else {
    peer.pendingCandidates.push(iceCandidate);
    console.log("ICE candidate queued:", remoteId);
  }
}

async function flushPendingIceCandidates(remoteId) {
  const peer = peers.get(remoteId);
  if (!peer) return;

  const pc = peer.pc;

  if (!pc.remoteDescription || !pc.remoteDescription.type) {
    return;
  }

  while (peer.pendingCandidates.length > 0) {
    const candidate = peer.pendingCandidates.shift();

    try {
      await pc.addIceCandidate(candidate);
      console.log("queued ICE candidate added:", remoteId);
    } catch (error) {
      console.warn("queued ICE candidate failed:", remoteId, error);
    }
  }
}

function loop() {
  analyzeLocalAudio();
  analyzeLocalFace();
  updateConversationState();
  applyLayout();
  applyVisualStates();
  maybeSendState();

  requestAnimationFrame(loop);
}

function analyzeLocalAudio() {
  const now = Date.now();

  if (!analyser) return;

  if (localState.muted) {
    localState.volume = 0;
    localState.isSpeaking = false;
    lastSpeakingTick = now;
    return;
  }

  analyser.getByteTimeDomainData(audioData);

  let sum = 0;

  for (let i = 0; i < audioData.length; i++) {
    const normalized = (audioData[i] - 128) / 128;
    sum += normalized * normalized;
  }

  const rms = Math.sqrt(sum / audioData.length);

  const delta = now - lastSpeakingTick;
  lastSpeakingTick = now;

  localState.volume = rms;

  if (rms > 0.01) {
    console.log("mic rms:", rms, "isSpeaking:", localState.isSpeaking);
  }

  if (!localState.isSpeaking) {
    if (rms > SPEECH_START_THRESHOLD) {
      if (speechCandidateSince === null) {
        speechCandidateSince = now;
      }

      if (now - speechCandidateSince > SPEECH_START_HOLD_MS) {
        localState.isSpeaking = true;
        silenceCandidateSince = null;
      }
    } else {
      speechCandidateSince = null;
    }
  } else {
    if (rms < SPEECH_STOP_THRESHOLD) {
      if (silenceCandidateSince === null) {
        silenceCandidateSince = now;
      }

      if (now - silenceCandidateSince > SPEECH_STOP_HOLD_MS) {
        localState.isSpeaking = false;
        speechCandidateSince = null;
      }
    } else {
      silenceCandidateSince = null;
    }
  }

  if (localState.isSpeaking) {
    localState.speakingMs += delta;
  }
}

function analyzeLocalFace() {
  if (!faceLandmarker || !localVideoEl || localVideoEl.readyState < 2) {
    return;
  }

  const result = faceLandmarker.detectForVideo(localVideoEl, performance.now());

  const landmarks = result.faceLandmarks?.[0];

  if (!landmarks) {
    localState.lipOpen = false;
    localState.leaning = false;
    localState.gazingSpeaker = false;
    return;
  }

  localState.lipOpen = detectLipParting(landmarks, result);
  localState.leaning = detectLeaningForward(landmarks);
  localState.gazingSpeaker = detectGazingAtSpeaker(landmarks);
}

function detectLipParting(landmarks, result) {
  const upperLip = landmarks[13];
  const lowerLip = landmarks[14];
  const forehead = landmarks[10];
  const chin = landmarks[152];

  const faceHeight = distance2D(forehead, chin);
  const mouthGap = distance2D(upperLip, lowerLip);
  const normalizedGap = mouthGap / faceHeight;

  const blendshapes = result.faceBlendshapes?.[0]?.categories || [];
  const jawOpen =
    blendshapes.find((c) => c.categoryName === "jawOpen")?.score || 0;

  return normalizedGap > LIP_GAP_THRESHOLD || jawOpen > JAW_OPEN_THRESHOLD;
}

function detectLeaningForward(landmarks) {
  const leftCheek = landmarks[234];
  const rightCheek = landmarks[454];

  const faceWidth = distance2D(leftCheek, rightCheek);

  if (!faceScaleBaseline) {
    faceScaleBaseline = faceWidth;
    return false;
  }

  faceScaleBaseline = faceScaleBaseline * 0.995 + faceWidth * 0.005;

  return faceWidth > faceScaleBaseline * LEAN_FORWARD_SCALE;
}

function getFocusSpeakerId() {
  return activeSpeakerId || heldSpeakerId;
}

function detectGazingAtSpeaker(landmarks) {
  const focusSpeakerId = getFocusSpeakerId();

  if (!focusSpeakerId || focusSpeakerId === myId) {
    return false;
  }

  const speaker = participants.get(focusSpeakerId);
  if (!speaker) return false;

  const speakerRect = speaker.tile.getBoundingClientRect();

  const targetX =
    (speakerRect.left + speakerRect.width / 2 - window.innerWidth / 2) /
    (window.innerWidth / 2);

  const targetY =
    (speakerRect.top + speakerRect.height / 2 - window.innerHeight / 2) /
    (window.innerHeight / 2);

  const targetLength = Math.hypot(targetX, targetY);

  const nose = landmarks[1];
  const leftEye = landmarks[33];
  const rightEye = landmarks[263];
  const forehead = landmarks[10];
  const chin = landmarks[152];

  const eyeCenterX = (leftEye.x + rightEye.x) / 2;
  const faceHeight = distance2D(forehead, chin);

  let lookX = (nose.x - eyeCenterX) * 6;
  let lookY = (nose.y - (forehead.y + chin.y) / 2) / faceHeight;

  lookX = -lookX;
  lookX = clamp(lookX, -1, 1);
  lookY = clamp(lookY, -1, 1);

  if (targetLength < 0.22) {
    return Math.abs(lookX) < 0.45 && Math.abs(lookY) < 0.55;
  }

  const targetNorm = {
    x: targetX / targetLength,
    y: targetY / targetLength,
  };

  const lookLength = Math.hypot(lookX, lookY);
  if (lookLength < 0.08) return false;

  const lookNorm = {
    x: lookX / lookLength,
    y: lookY / lookLength,
  };

  const dot = lookNorm.x * targetNorm.x + lookNorm.y * targetNorm.y;

  return dot > 0.42;
}

function updateConversationState() {
  const users = Array.from(participants.values());
  const now = Date.now();

  let bestSpeaker = null;
  let bestVolume = 0;
  let hasAnySpeaker = false;

  users.forEach((participant) => {
    const state = participant.state;
    const volume = state.volume || 0;

    const isRealSpeaker =
      !state.muted &&
      state.isSpeaking &&
      volume > ACTIVE_SPEAKER_VOLUME;

    if (isRealSpeaker) {
      hasAnySpeaker = true;

      if (volume >= bestVolume) {
        bestVolume = volume;
        bestSpeaker = participant.id;
      }
    }
  });

  if (hasAnySpeaker && bestSpeaker) {
    activeSpeakerId = bestSpeaker;
    heldSpeakerId = bestSpeaker;

    lastAnySpeakerAt = now;
    noSpeakerMode = false;

    console.log("speaker detected:", bestSpeaker, "volume:", bestVolume);
    return;
  }

  activeSpeakerId = null;

  const silenceTime = now - lastAnySpeakerAt;

  noSpeakerMode =
    circleModeEnabled &&
    users.length >= 2 &&
    silenceTime >= SILENCE_TO_CIRCLE_MS;

  if (noSpeakerMode) {
    heldSpeakerId = null;
  }
}

function applyLayout() {
  const count = participants.size;

  if (count === 0) return;

  if (noSpeakerMode && count >= 2) {
    applyCircleLayout();
  } else {
    applyGridLayout(count);
  }
}

function resetTileForGrid(tile) {
  tile.style.position = "";
  tile.style.left = "";
  tile.style.top = "";
  tile.style.height = "";
  tile.style.transform = "";
  tile.style.zIndex = "";

  tile.style.removeProperty("--x");
  tile.style.removeProperty("--y");
  tile.style.removeProperty("--tile-w");

  tile.classList.remove("inner-ring", "outer-ring");
}

function applyGridLayout(count) {
  stage.classList.add("grid-mode");
  stage.classList.remove("circle-mode");

  if (count === 1) {
    stage.style.display = "flex";
    stage.style.justifyContent = "center";
    stage.style.alignItems = "center";
    stage.style.gridTemplateColumns = "";
    stage.style.gridTemplateRows = "";

    participants.forEach((participant) => {
      const tile = participant.tile;

      resetTileForGrid(tile);

      tile.style.width = "min(72vw, 900px)";
      tile.style.maxWidth = "900px";
      tile.style.minWidth = "520px";
    });

    return;
  }

  stage.style.display = "grid";
  stage.style.justifyContent = "center";
  stage.style.alignContent = "center";
  stage.style.alignItems = "center";

  const cols = Math.min(5, Math.ceil(Math.sqrt(count)));
  const rows = Math.min(5, Math.ceil(count / cols));

  stage.style.gridTemplateColumns = `repeat(${cols}, minmax(220px, ${getTileMaxWidth(
    count
  )}px))`;

  stage.style.gridTemplateRows = `repeat(${rows}, auto)`;

  participants.forEach((participant) => {
    const tile = participant.tile;

    resetTileForGrid(tile);

    tile.style.width = "100%";
    tile.style.maxWidth = "";
    tile.style.minWidth = "180px";
  });
}

function getTileMaxWidth(count) {
  if (count <= 2) return 560;
  if (count <= 4) return 420;
  if (count <= 9) return 320;
  if (count <= 16) return 250;
  return 210;
}

function getCircleBaseTileWidth(count, usableWidth, usableHeight) {
  let base;

  if (count <= 2) base = 130;
  else if (count <= 3) base = 118;
  else if (count <= 5) base = 110;
  else if (count <= 8) base = 96;
  else if (count <= 12) base = 84;
  else if (count <= 16) base = 72;
  else if (count <= 20) base = 64;
  else base = 56;

  const viewportLimit = Math.min(usableWidth / 5.2, usableHeight / 4.5);
  return Math.min(base, viewportLimit);
}

function getCircleGap(count) {
  if (count <= 3) return 38;
  if (count <= 5) return 30;
  if (count <= 8) return 20;
  if (count <= 12) return 12;
  return 8;
}

function getTightRadius(count, tileW, gap) {
  if (count <= 1) return 0;

  return (tileW + gap) / (2 * Math.sin(Math.PI / count));
}

function getLowCountAngles(total) {
  const top = -Math.PI / 2;

  if (total === 2) {
    return {
      outer: [top],
      inner: [top + Math.PI],
    };
  }

  if (total === 3) {
    return {
      outer: [top - Math.PI / 3, top + Math.PI / 3],
      inner: [top + Math.PI],
    };
  }

  return null;
}

function applyCircleLayout() {
  stage.classList.remove("grid-mode");
  stage.classList.add("circle-mode");

  stage.style.display = "block";
  stage.style.gridTemplateColumns = "";
  stage.style.gridTemplateRows = "";

  orbitAngle += 0.0025;

  const users = Array.from(participants.values());
  const count = users.length;
  if (count === 0) return;

  const rect = stage.getBoundingClientRect();

  const sideSafeArea = 48;
  const topSafeArea = 38;
  const bottomSafeArea = 132;

  const usableWidth = rect.width - sideSafeArea * 2;
  const usableHeight = rect.height - topSafeArea - bottomSafeArea;

  const centerX = rect.width / 2;
  const centerY = topSafeArea + usableHeight / 2;

  const ranked = [...users].sort(
    (a, b) => (b.state.speakingMs || 0) - (a.state.speakingMs || 0)
  );

  const outerCount = Math.ceil(count / 2);
  const outerUsers = ranked.slice(0, outerCount);
  const innerUsers = ranked.slice(outerCount);

  const baseTileW = getCircleBaseTileWidth(count, usableWidth, usableHeight);

  if (count === 2 || count === 3) {
    const outerTileW = clamp(baseTileW, 86, 132);
    const innerTileW = clamp(baseTileW * 0.86, 72, 112);

    const outerTileH = outerTileW * 0.5625;

    const maxOuterRadius = Math.min(
      usableWidth / 2 - outerTileW / 2 - 24,
      usableHeight / 2 - outerTileH / 2 - 24
    );

    const outerRadius = clamp(
      Math.min(usableWidth, usableHeight) * 0.2,
      126,
      Math.min(maxOuterRadius, 210)
    );

    const innerRadius = clamp(
      outerRadius * 0.48,
      58,
      outerRadius - 66
    );

    const preset = getLowCountAngles(count);

    positionCircleRing({
      users: outerUsers,
      centerX,
      centerY,
      radius: outerRadius,
      tileW: outerTileW,
      startAngle: orbitAngle,
      ringClass: "outer-ring",
      rotateTiles: true,
      angleList: preset.outer.map((angle) => angle + orbitAngle),
    });

    positionCircleRing({
      users: innerUsers,
      centerX,
      centerY,
      radius: innerRadius,
      tileW: innerTileW,
      startAngle: orbitAngle,
      ringClass: "inner-ring",
      rotateTiles: true,
      angleList: preset.inner.map((angle) => angle + orbitAngle),
    });

    return;
  }

  const outerTileW = clamp(baseTileW, 54, 116);
  const innerTileW = clamp(baseTileW * 0.82, 44, 94);

  const outerTileH = outerTileW * 0.5625;

  const maxOuterRadius = Math.min(
    usableWidth / 2 - outerTileW / 2 - 24,
    usableHeight / 2 - outerTileH / 2 - 24
  );

  const outerRadius = clamp(
    getTightRadius(outerUsers.length, outerTileW, getCircleGap(count)),
    128,
    Math.min(maxOuterRadius, 250)
  );

  const innerRadius = clamp(
    outerRadius * 0.55,
    62,
    outerRadius - 58
  );

  positionCircleRing({
    users: outerUsers,
    centerX,
    centerY,
    radius: outerRadius,
    tileW: outerTileW,
    startAngle: orbitAngle - Math.PI / 2,
    ringClass: "outer-ring",
    rotateTiles: true,
  });

  positionCircleRing({
    users: innerUsers,
    centerX,
    centerY,
    radius: innerRadius,
    tileW: innerTileW,
    startAngle:
      orbitAngle -
      Math.PI / 2 +
      Math.PI / Math.max(innerUsers.length, 1),
    ringClass: "inner-ring",
    rotateTiles: true,
  });
}

function positionCircleRing({
  users,
  centerX,
  centerY,
  radius,
  tileW,
  startAngle,
  ringClass,
  rotateTiles,
  angleList = null,
}) {
  if (!users.length) return;

  const tileH = tileW * 0.5625;

  users.forEach((participant, index) => {
    const angle = angleList
      ? angleList[index]
      : startAngle + (Math.PI * 2 * index) / users.length;

    const x = centerX + Math.cos(angle) * radius - tileW / 2;
    const y = centerY + Math.sin(angle) * radius - tileH / 2;

    const tile = participant.tile;

    tile.style.position = "absolute";
    tile.style.left = `${x}px`;
    tile.style.top = `${y}px`;
    tile.style.width = `${tileW}px`;
    tile.style.height = `${tileH}px`;
    tile.style.minWidth = "0px";
    tile.style.maxWidth = "none";
    tile.style.zIndex = ringClass === "inner-ring" ? "3" : "2";

    tile.style.transform = rotateTiles
      ? `rotate(${angle + Math.PI / 2}rad)`
      : "none";

    tile.style.removeProperty("--x");
    tile.style.removeProperty("--y");
    tile.style.removeProperty("--tile-w");

    tile.classList.remove("inner-ring", "outer-ring");
    tile.classList.add(ringClass);
  });
}

function applyVisualStates() {
  const singleParticipant = participants.size === 1;
  const focusSpeakerId = getFocusSpeakerId();

  participants.forEach((participant) => {
    const state = participant.state;
    const tile = participant.tile;

    const isSpeakerTile =
      focusSpeakerId !== null && participant.id === focusSpeakerId;

    const isReady =
      !state.muted &&
      !isSpeakerTile &&
      !noSpeakerMode &&
      state.lipOpen;

    const leaningReady = isReady && state.leaning;
    const gazeReady = isReady && state.gazingSpeaker;

    if (noSpeakerMode) {
      tile.classList.remove(
        "flat",
        "speaker",
        "leaning",
        "gazing",
        "mouth-open"
      );
      tile.classList.add("upright");
    } else {
      tile.classList.toggle("speaker", isSpeakerTile);

      tile.classList.toggle("upright", isSpeakerTile || singleParticipant);

      tile.classList.toggle("flat", !isSpeakerTile && !singleParticipant);

      tile.classList.toggle("mouth-open", isReady);
      tile.classList.toggle("leaning", leaningReady);
      tile.classList.toggle("gazing", gazeReady);
    }

    tile.classList.toggle("muted", state.muted);

    const lipDot = tile.querySelector(".lip-dot");
    const leanDot = tile.querySelector(".lean-dot");
    const gazeDot = tile.querySelector(".gaze-dot");

    lipDot?.classList.toggle("active", Boolean(state.lipOpen));
    leanDot?.classList.toggle("active", Boolean(state.leaning));
    gazeDot?.classList.toggle("active", Boolean(state.gazingSpeaker));

    updateGazePullDirection(participant);
  });
}

function updateGazePullDirection(participant) {
  const focusSpeakerId = getFocusSpeakerId();

  if (!focusSpeakerId || focusSpeakerId === participant.id) {
    participant.tile.style.setProperty("--pull-x", 0);
    participant.tile.style.setProperty("--pull-y", 0);
    return;
  }

  const speaker = participants.get(focusSpeakerId);
  if (!speaker) return;

  const speakerRect = speaker.tile.getBoundingClientRect();
  const tileRect = participant.tile.getBoundingClientRect();

  const dx =
    speakerRect.left +
    speakerRect.width / 2 -
    (tileRect.left + tileRect.width / 2);

  const dy =
    speakerRect.top +
    speakerRect.height / 2 -
    (tileRect.top + tileRect.height / 2);

  const length = Math.hypot(dx, dy) || 1;

  participant.tile.style.setProperty("--pull-x", dx / length);
  participant.tile.style.setProperty("--pull-y", dy / length);
}

function maybeSendState() {
  const now = Date.now();

  if (now - lastStateSentAt < 100) return;

  lastStateSentAt = now;

  sendStateNow();
}

function sendStateNow() {
  socket.emit("user-state", {
    muted: localState.muted,
    cameraOff: localState.cameraOff,
    isSpeaking: localState.isSpeaking,
    volume: localState.volume,
    lipOpen: localState.lipOpen,
    leaning: localState.leaning,
    gazingSpeaker: localState.gazingSpeaker,
    speakingMs: localState.speakingMs,
  });

  if (myId && participants.has(myId)) {
    participants.get(myId).state = {
      ...participants.get(myId).state,
      ...localState,
    };
  }
}

function distance2D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
