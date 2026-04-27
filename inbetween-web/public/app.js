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

/*
  activeSpeakerId: 지금 실제로 말하고 있는 사람
  heldSpeakerId: 마지막으로 speaker였던 사람
  heldSpeakerId는 다음 speaker가 나타날 때까지 유지됨
*/
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

/*
  Speaker detection 값을 더 민감하게 조정
*/
const SPEECH_START_THRESHOLD = 0.018;
const SPEECH_STOP_THRESHOLD = 0.01;
const SPEECH_START_HOLD_MS = 80;
const SPEECH_STOP_HOLD_MS = 700;

/*
  정적 5초 후 circle mode
*/
const SILENCE_TO_CIRCLE_MS = 5000;

/*
  speaker로 인정할 최소 volume
*/
const ACTIVE_SPEAKER_VOLUME = 0.012;

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

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

init();

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
      addParticipant({
        id,
        name,
        stream: new MediaStream(),
        state,
        isLocal: false,
      });
    });

    socket.on("user-left", ({ id }) => {
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

      /*
        Circle Mode On을 누른 시점부터 5초 정적 카운트 시작
      */
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
  video.srcObject = stream;

  if (isLocal) {
    video.muted = true;
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
    stream,
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

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.emit("signal", {
    to: remoteId,
    type: "offer",
    sdp: pc.localDescription,
  });
}

function ensurePeer(remoteId) {
  if (peers.has(remoteId)) {
    return peers.get(remoteId).pc;
  }

  const pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
  });

  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
  });

  const remoteStream = new MediaStream();

  pc.ontrack = (event) => {
    event.streams[0].getTracks().forEach((track) => {
      remoteStream.addTrack(track);
    });

    const participant = participants.get(remoteId);

    if (participant) {
      participant.stream = remoteStream;
      participant.video.srcObject = remoteStream;
    }
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;

    socket.emit("signal", {
      to: remoteId,
      type: "ice",
      candidate: event.candidate,
    });
  };

  peers.set(remoteId, {
    pc,
    stream: remoteStream,
  });

  return pc;
}

async function handleSignal({ from, type, sdp, candidate }) {
  const pc = ensurePeer(from);

  if (type === "offer") {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit("signal", {
      to: from,
      type: "answer",
      sdp: pc.localDescription,
    });
  }

  if (type === "answer") {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }

  if (type === "ice" && candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.warn("ICE candidate error:", error);
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

  /*
    Console에서 mic rms 확인용.
    나중에 안정되면 이 console.log는 지워도 됨.
  */
  if (rms > 0.01) {
    console.log("mic rms:", rms, "isSpeaking:", localState.isSpeaking);
  }

  /*
    speaking 시작 감지
  */
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
    /*
      speaking 종료 감지
    */
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

  return normalizedGap > 0.045 || jawOpen > 0.22;
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

  return faceWidth > faceScaleBaseline * 1.12;
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

    /*
      speaker 판단:
      isSpeaking이 true이고 volume이 최소 기준 이상이면 speaker로 인정
    */
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

  /*
    실제로 말하는 사람은 없음.
    하지만 heldSpeakerId는 유지한다.
    그래서 마지막 speaker 화면은 다음 speaker가 나타날 때까지 계속 세워져 있음.
  */
  activeSpeakerId = null;

  const silenceTime = now - lastAnySpeakerAt;

  /*
    Circle Mode On 상태에서
    실제 speaker가 없고
    정적 5초가 지나면 circle mode 진입.
  */
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

  if (count <= 3) base = 138;
  else if (count <= 5) base = 122;
  else if (count <= 8) base = 104;
  else if (count <= 12) base = 88;
  else if (count <= 16) base = 76;
  else if (count <= 20) base = 66;
  else base = 58;

  const viewportLimit = Math.min(usableWidth / 5.8, usableHeight / 4.8);
  return Math.min(base, viewportLimit);
}

function getCircleGap(count) {
  if (count <= 4) return 12;
  if (count <= 8) return 10;
  if (count <= 12) return 8;
  return 6;
}

function getTightRadius(count, tileW, gap) {
  if (count <= 1) return 0;

  return (tileW + gap) / (2 * Math.sin(Math.PI / count));
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

  /*
    speakingMs 기준 정렬:
    speakingMs가 큰 사람 = 말을 많이 한 사람
  */
  const ranked = [...users].sort(
    (a, b) => (b.state.speakingMs || 0) - (a.state.speakingMs || 0)
  );

  /*
    말을 많이 한 절반 = outer ring
    말을 적게 한 절반 = inner ring
  */
  const outerCount = Math.ceil(count / 2);
  const outerIds = new Set(ranked.slice(0, outerCount).map((p) => p.id));

  const outerUsers = users.filter((p) => outerIds.has(p.id));
  const innerUsers = users.filter((p) => !outerIds.has(p.id));

  const baseTileW = getCircleBaseTileWidth(count, usableWidth, usableHeight);

  const outerTileW = clamp(baseTileW, 54, 120);
  const innerTileW = clamp(baseTileW * 0.88, 48, 105);

  const outerTileH = outerTileW * 0.5625;

  const maxRadius = Math.min(
    usableWidth / 2 - outerTileW / 2 - 24,
    usableHeight / 2 - outerTileH / 2 - 24
  );

  /*
    outer ring은 너무 넓지 않게 촘촘하게.
    inner ring은 조금 안쪽으로.
  */
  const baseRadius = getTightRadius(count, outerTileW, getCircleGap(count));

  const outerRadius = clamp(baseRadius, 95, Math.min(maxRadius, 220));
  const innerRadius = clamp(outerRadius * 0.58, 54, outerRadius - 42);

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
}) {
  if (!users.length) return;

  const tileH = tileW * 0.5625;

  users.forEach((participant, index) => {
    const angle = startAngle + (Math.PI * 2 * index) / users.length;

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
    tile.style.zIndex = ringClass === "outer-ring" ? "2" : "3";

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
  
      /*
        pre-speech cue는 speaker가 아닌 사람에게만 적용
      */
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
        /*
          speaker / held speaker만 upright
        */
        tile.classList.toggle("speaker", isSpeakerTile);
  
        tile.classList.toggle(
          "upright",
          isSpeakerTile || singleParticipant
        );
  
        /*
          speaker가 아닌 사람들만 flat
        */
        tile.classList.toggle(
          "flat",
          !isSpeakerTile && !singleParticipant
        );
  
        /*
          speaker가 아닌 사람들한테만 cue 적용
        */
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