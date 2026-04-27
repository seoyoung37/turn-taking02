const {
  Room,
  RoomEvent,
  Track,
  VideoPresets,
} = window.LivekitClient;

let FaceLandmarker;
let FilesetResolver;

console.log("app.js loaded - LiveKit version");

const stage = document.getElementById("stage");
const muteBtn = document.getElementById("muteBtn");
const cameraBtn = document.getElementById("cameraBtn");
const copyLinkBtn = document.getElementById("copyLinkBtn");
const circleToggleBtn = document.getElementById("circleToggleBtn");
const leaveBtn = document.getElementById("leaveBtn");

const url = new URL(window.location.href);
const roomId = url.searchParams.get("room") || "studio";

let displayName =
  localStorage.getItem("inbetween-name") ||
  prompt("Your name?") ||
  "Participant";

localStorage.setItem("inbetween-name", displayName);

const clientIdentity = `${displayName}-${crypto.randomUUID().slice(0, 8)}`;

let lkRoom = null;
let myId = null;
let localVideoEl = null;

const participants = new Map();

let audioContext = null;
let analyser = null;
let audioData = null;

let faceLandmarker = null;
let faceScaleBaseline = null;

let activeSpeakerId = null;
let heldSpeakerId = null;

let lastAnySpeakerAt = Date.now();
let noSpeakerMode = false;
let circleModeEnabled = false;
let circleModeEnabledAt = null;
let orbitAngle = 0;

let hasLeftRoom = false;

let lastStateSentAt = 0;
let lastSpeakingTick = Date.now();

const SPEECH_START_THRESHOLD = 0.018;
const SPEECH_STOP_THRESHOLD = 0.01;
const SPEECH_START_HOLD_MS = 80;
const SPEECH_STOP_HOLD_MS = 700;

const SILENCE_TO_CIRCLE_MS = 5000;
const ACTIVE_SPEAKER_VOLUME = 0.012;

const LIP_GAP_THRESHOLD = 0.032;
const JAW_OPEN_THRESHOLD = 0.13;
const LEAN_FORWARD_SCALE = 1.06;

let speechCandidateSince = null;
let silenceCandidateSince = null;

const STATE_TOPIC = "inbetween-state";

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

const encoder = new TextEncoder();
const decoder = new TextDecoder();

registerMediaUnlock();
init();

function registerMediaUnlock() {
  const unlock = () => {
    if (audioContext && audioContext.state === "suspended") {
      audioContext.resume().catch((error) => {
        console.warn("audioContext resume failed:", error);
      });
    }

    participants.forEach((participant) => {
      tryPlayMedia(participant.video);
      tryPlayMedia(participant.audio);
    });

    if (lkRoom && lkRoom.startAudio) {
      lkRoom.startAudio().catch((error) => {
        console.warn("LiveKit startAudio failed:", error);
      });
    }
  };

  document.addEventListener("click", unlock);
  document.addEventListener("touchstart", unlock);
  document.addEventListener("keydown", unlock);
}

function tryPlayMedia(element) {
  if (!element) return;

  const promise = element.play?.();

  if (promise && typeof promise.catch === "function") {
    promise.catch((error) => {
      console.warn("media play blocked or delayed:", error);
    });
  }
}

async function init() {
  console.log("init started");

  try {
    setupButtons();

    const tokenInfo = await fetchToken();

    lkRoom = new Room({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: {
        resolution: VideoPresets.h720.resolution,
      },
    });

    setupLiveKitEvents();

    console.log("connecting to LiveKit:", tokenInfo.url);

    await lkRoom.connect(tokenInfo.url, tokenInfo.token, {
      autoSubscribe: true,
    });

    console.log("connected to LiveKit room:", lkRoom.name);

    myId = lkRoom.localParticipant.identity;

    addParticipant({
      id: myId,
      name: displayName,
      isLocal: true,
    });

    await lkRoom.localParticipant.setCameraEnabled(true);
    await lkRoom.localParticipant.setMicrophoneEnabled(true);

    localState.muted = false;
    localState.cameraOff = false;

    attachLocalMediaTracks();
    setupAudioAnalyzer();

    setupFaceLandmarker()
      .then(() => {
        console.log("FaceLandmarker ready");
      })
      .catch((error) => {
        console.error("FaceLandmarker failed:", error);
      });

    lkRoom.remoteParticipants.forEach((participant) => {
      addLiveKitParticipant(participant);
      attachExistingTracks(participant);
    });

    sendStateNow();

    requestAnimationFrame(loop);
  } catch (error) {
    console.error("LiveKit init error:", error);
    alert(
      "Failed to join the LiveKit room. Check LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET in Railway Variables."
    );
  }
}

async function fetchToken() {
  const params = new URLSearchParams({
    room: roomId,
    name: displayName,
    identity: clientIdentity,
  });

  const response = await fetch(`/token?${params.toString()}`);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText);
  }

  return response.json();
}

function setupLiveKitEvents() {
  lkRoom
    .on(RoomEvent.ParticipantConnected, (participant) => {
      console.log("participant connected:", participant.identity);
      addLiveKitParticipant(participant);
      applyLayout();
    })
    .on(RoomEvent.ParticipantDisconnected, (participant) => {
      console.log("participant disconnected:", participant.identity);
      removeParticipant(participant.identity);
      applyLayout();
    })
    .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      console.log(
        "track subscribed:",
        participant.identity,
        track.kind,
        publication.source
      );

      addLiveKitParticipant(participant);
      attachRemoteTrack(track, publication, participant);
    })
    .on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      console.log(
        "track unsubscribed:",
        participant.identity,
        track.kind,
        publication.source
      );

      detachRemoteTrack(track, publication, participant);
    })
    .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      handleActiveSpeakersChanged(speakers);
    })
    .on(RoomEvent.DataReceived, (payload, participant, kind, topic) => {
      handleDataReceived(payload, participant, topic);
    })
    .on(RoomEvent.Disconnected, () => {
      console.log("LiveKit room disconnected");
    })
    .on(RoomEvent.MediaDevicesError, (error) => {
      console.error("LiveKit media device error:", error);
    });
}

function addLiveKitParticipant(livekitParticipant) {
  const id = livekitParticipant.identity;
  const name = livekitParticipant.name || id;

  addParticipant({
    id,
    name,
    isLocal: false,
  });
}

function addParticipant({ id, name, isLocal }) {
  if (participants.has(id)) return;

  const tile = document.createElement("section");
  tile.className = "tile";

  if (isLocal) {
    tile.classList.add("local");
  }

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.volume = 0;

  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.playsInline = true;
  audio.style.display = "none";

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
  tile.appendChild(audio);
  tile.appendChild(nameTag);
  tile.appendChild(cue);

  stage.appendChild(tile);

  participants.set(id, {
    id,
    name,
    tile,
    video,
    audio,
    isLocal,
    state: {
      muted: false,
      cameraOff: false,
      isSpeaking: false,
      volume: 0,
      lipOpen: false,
      leaning: false,
      gazingSpeaker: false,
      speakingMs: 0,
    },
  });

  tryPlayMedia(video);
  tryPlayMedia(audio);
}

function removeParticipant(id) {
  const participant = participants.get(id);

  if (participant) {
    participant.tile.remove();
    participants.delete(id);
  }

  if (activeSpeakerId === id) {
    activeSpeakerId = null;
  }

  if (heldSpeakerId === id) {
    heldSpeakerId = null;
  }
}

function attachLocalMediaTracks() {
  if (!lkRoom || !localVideoEl) return;

  const cameraTrack = findParticipantTrack(
    lkRoom.localParticipant,
    Track.Source.Camera
  );

  if (cameraTrack) {
    cameraTrack.attach(localVideoEl);
    tryPlayMedia(localVideoEl);
  }
}

function setupAudioAnalyzer() {
  if (!lkRoom) return;

  const micTrack = findParticipantTrack(
    lkRoom.localParticipant,
    Track.Source.Microphone
  );

  const mediaStreamTrack = getMediaStreamTrack(micTrack);

  if (!mediaStreamTrack) {
    console.warn("No local microphone MediaStreamTrack found.");
    return;
  }

  audioContext = new AudioContext();

  const stream = new MediaStream([mediaStreamTrack]);
  const source = audioContext.createMediaStreamSource(stream);

  analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;

  audioData = new Uint8Array(analyser.fftSize);

  source.connect(analyser);
}

function findParticipantTrack(participant, source) {
  if (!participant) return null;

  if (typeof participant.getTrackPublication === "function") {
    const publication = participant.getTrackPublication(source);
    const track =
      publication?.track ||
      publication?.videoTrack ||
      publication?.audioTrack ||
      null;

    if (track) return track;
  }

  const publications =
    participant.trackPublications ||
    participant.videoTrackPublications ||
    participant.audioTrackPublications;

  if (publications && typeof publications.values === "function") {
    for (const publication of publications.values()) {
      if (publication.source === source) {
        return (
          publication.track ||
          publication.videoTrack ||
          publication.audioTrack ||
          null
        );
      }
    }
  }

  return null;
}

function getMediaStreamTrack(livekitTrack) {
  return (
    livekitTrack?.mediaStreamTrack ||
    livekitTrack?._mediaStreamTrack ||
    null
  );
}

function attachExistingTracks(livekitParticipant) {
  const publications = livekitParticipant.trackPublications;

  if (!publications || typeof publications.values !== "function") return;

  for (const publication of publications.values()) {
    const track =
      publication.track ||
      publication.videoTrack ||
      publication.audioTrack ||
      null;

    if (track && publication.isSubscribed) {
      attachRemoteTrack(track, publication, livekitParticipant);
    }
  }
}

function attachRemoteTrack(track, publication, livekitParticipant) {
  const id = livekitParticipant.identity;
  const participant = participants.get(id);

  if (!participant) return;

  if (track.kind === Track.Kind.Video) {
    track.attach(participant.video);
    participant.video.muted = true;
    participant.video.volume = 0;
    participant.video.dataset.livekitVideo = publication.trackSid || "camera";
    tryPlayMedia(participant.video);
  }

  if (track.kind === Track.Kind.Audio) {
    track.attach(participant.audio);
    participant.audio.muted = false;
    participant.audio.volume = 1;
    participant.audio.dataset.livekitAudio = publication.trackSid || "mic";
    tryPlayMedia(participant.audio);
  }
}

function detachRemoteTrack(track, publication, livekitParticipant) {
  const id = livekitParticipant.identity;
  const participant = participants.get(id);

  if (!participant) return;

  if (track.kind === Track.Kind.Video) {
    track.detach(participant.video);
    participant.video.srcObject = null;
  }

  if (track.kind === Track.Kind.Audio) {
    track.detach(participant.audio);
    participant.audio.srcObject = null;
  }
}

function handleActiveSpeakersChanged(speakers) {
  const now = Date.now();
  const speakerIds = new Set(speakers.map((speaker) => speaker.identity));

  participants.forEach((participant) => {
    const livekitParticipant =
      participant.id === myId
        ? lkRoom.localParticipant
        : lkRoom.remoteParticipants.get(participant.id);

    const isSpeaking = speakerIds.has(participant.id);
    const audioLevel = livekitParticipant?.audioLevel || 0;

    participant.state.isSpeaking = isSpeaking;
    participant.state.volume = audioLevel;

    if (isSpeaking) {
      participant.state.speakingMs += 100;
    }
  });

  const primarySpeaker = speakers.find((speaker) =>
    participants.has(speaker.identity)
  );

  if (primarySpeaker) {
    activeSpeakerId = primarySpeaker.identity;
    heldSpeakerId = primarySpeaker.identity;
    lastAnySpeakerAt = now;
    noSpeakerMode = false;
  }
}

function handleDataReceived(payload, livekitParticipant, topic) {
  if (topic !== STATE_TOPIC) return;
  if (!livekitParticipant) return;

  try {
    const message = JSON.parse(decoder.decode(payload));

    if (message.type !== "state") return;

    const participant = participants.get(livekitParticipant.identity);
    if (!participant) return;

    participant.state = {
      ...participant.state,
      ...message.state,
    };
  } catch (error) {
    console.warn("Failed to parse state message:", error);
  }
}

function setupButtons() {
  if (muteBtn) {
    muteBtn.addEventListener("click", async () => {
      if (!lkRoom) return;

      const nextMuted = !localState.muted;

      await lkRoom.localParticipant.setMicrophoneEnabled(!nextMuted);

      localState.muted = nextMuted;

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
    cameraBtn.addEventListener("click", async () => {
      if (!lkRoom) return;

      const nextCameraOff = !localState.cameraOff;

      await lkRoom.localParticipant.setCameraEnabled(!nextCameraOff);

      localState.cameraOff = nextCameraOff;

      if (!localState.cameraOff) {
        attachLocalMediaTracks();
      }

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

  if (leaveBtn) {
    leaveBtn.addEventListener("click", leaveRoom);
  }
}

async function leaveRoom() {
  if (hasLeftRoom) return;

  hasLeftRoom = true;

  try {
    if (lkRoom && lkRoom.localParticipant) {
      await lkRoom.localParticipant.setCameraEnabled(false).catch(() => {});
      await lkRoom.localParticipant.setMicrophoneEnabled(false).catch(() => {});
    }

    if (lkRoom) {
      lkRoom.disconnect();
    }
  } catch (error) {
    console.warn("Leave room error:", error);
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  participants.forEach((participant) => {
    participant.tile.remove();
  });

  participants.clear();

  activeSpeakerId = null;
  heldSpeakerId = null;
  noSpeakerMode = false;

  stage.classList.remove("grid-mode", "circle-mode");
  stage.innerHTML = "";

  const message = document.createElement("div");
  message.className = "leave-message";
  message.textContent = "You left the room.";

  stage.appendChild(message);

  [muteBtn, cameraBtn, circleToggleBtn, copyLinkBtn].forEach((button) => {
    if (button) {
      button.disabled = true;
    }
  });

  if (leaveBtn) {
    leaveBtn.textContent = "Left";
    leaveBtn.disabled = true;
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

function loop() {
  if (hasLeftRoom) return;

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

  let lookX = (nose.x - eyeCenterX) * 5.2;
  let lookY = (nose.y - (forehead.y + chin.y) / 2) / faceHeight;

  lookX = -lookX;
  lookX = clamp(lookX, -1, 1);
  lookY = clamp(lookY, -1, 1);

  if (targetLength < 0.28) {
    return Math.abs(lookX) < 0.62 && Math.abs(lookY) < 0.72;
  }

  const targetNorm = {
    x: targetX / targetLength,
    y: targetY / targetLength,
  };

  const lookLength = Math.hypot(lookX, lookY);
  if (lookLength < 0.06) return false;

  const lookNorm = {
    x: lookX / lookLength,
    y: lookY / lookLength,
  };

  const dot = lookNorm.x * targetNorm.x + lookNorm.y * targetNorm.y;

  return dot > 0.22;
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

  if (count <= 2) base = 180;
  else if (count <= 3) base = 165;
  else if (count <= 5) base = 155;
  else if (count <= 8) base = 140;
  else if (count <= 12) base = 126;
  else if (count <= 16) base = 110;
  else if (count <= 20) base = 96;
  else base = 82;

  const viewportLimit = Math.min(usableWidth / 3.8, usableHeight / 3.2);

  return Math.min(base, viewportLimit);
}

function getCircleGap(count) {
  if (count <= 3) return 46;
  if (count <= 5) return 38;
  if (count <= 8) return 30;
  if (count <= 12) return 24;
  if (count <= 16) return 18;
  return 14;
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

  orbitAngle += 0.005;

  const users = Array.from(participants.values());
  const count = users.length;
  if (count === 0) return;

  const rect = stage.getBoundingClientRect();

  const sideSafeArea = 64;
  const topSafeArea = 42;
  const bottomSafeArea = 136;

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
    const outerTileW = clamp(baseTileW, 120, 190);
    const innerTileW = clamp(baseTileW * 0.88, 105, 165);

    const outerTileH = outerTileW * 0.5625;

    const maxOuterRadius = Math.min(
      usableWidth / 2 - outerTileW / 2 - 24,
      usableHeight / 2 - outerTileH / 2 - 24
    );

    const outerRadius = clamp(
      Math.min(usableWidth, usableHeight) * 0.22,
      170,
      Math.min(maxOuterRadius, 360)
    );

    const innerRadius = clamp(outerRadius * 0.55, 88, outerRadius - 78);

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

  const outerTileW = clamp(baseTileW, 92, 170);
  const innerTileW = clamp(baseTileW * 0.88, 78, 145);

  const outerTileH = outerTileW * 0.5625;

  const maxOuterRadius = Math.min(
    usableWidth / 2 - outerTileW / 2 - 28,
    usableHeight / 2 - outerTileH / 2 - 28
  );

  const outerRadius = clamp(
    getTightRadius(outerUsers.length, outerTileW, getCircleGap(count)),
    185,
    Math.min(maxOuterRadius, 380)
  );

  const innerRadius = clamp(outerRadius * 0.56, 95, outerRadius - 82);

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
    const state = participant.isLocal
      ? {
          ...participant.state,
          ...localState,
        }
      : participant.state;

    const tile = participant.tile;

    const isSpeakerTile =
      focusSpeakerId !== null && participant.id === focusSpeakerId;

    const canShowPreSpeechCue =
      !singleParticipant &&
      !noSpeakerMode &&
      !isSpeakerTile &&
      !state.muted;

    const mouthReady = canShowPreSpeechCue && state.lipOpen;
    const gazeReady = mouthReady && state.gazingSpeaker;
    const leaningReady = mouthReady && state.leaning;

    if (noSpeakerMode) {
      tile.classList.remove(
        "flat",
        "speaker",
        "leaning",
        "gazing",
        "mouth-open",
        "turn-ready"
      );

      tile.classList.add("upright");
    } else {
      tile.classList.toggle("speaker", isSpeakerTile);

      tile.classList.toggle("upright", isSpeakerTile || singleParticipant);

      tile.classList.toggle("flat", !isSpeakerTile && !singleParticipant);

      tile.classList.toggle("turn-ready", mouthReady);
      tile.classList.toggle("mouth-open", mouthReady);
      tile.classList.toggle("gazing", gazeReady);
      tile.classList.toggle("leaning", leaningReady);
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

  if (now - lastStateSentAt < 120) return;

  lastStateSentAt = now;

  sendStateNow();
}

function sendStateNow() {
  if (!lkRoom || !lkRoom.localParticipant) return;

  const participant = participants.get(myId);

  if (participant) {
    participant.state = {
      ...participant.state,
      ...localState,
    };
  }

  const message = {
    type: "state",
    state: localState,
  };

  try {
    lkRoom.localParticipant.publishData(encoder.encode(JSON.stringify(message)), {
      reliable: false,
      topic: STATE_TOPIC,
    });
  } catch (error) {
    console.warn("publishData failed:", error);
  }
}

function distance2D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}