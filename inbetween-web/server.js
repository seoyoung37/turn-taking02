const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3000;

/*
  Serve public files:
  public/index.html
  public/style.css
  public/app.js
*/
app.use(express.static(path.join(__dirname, "public")));

/*
  Simple health check for Railway
*/
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

/*
  rooms structure:
  rooms = {
    roomId: Map {
      socketId: {
        id,
        name,
        state
      }
    }
  }
*/
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }

  return rooms.get(roomId);
}

function removeUserFromRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) return;

  room.delete(socket.id);

  socket.to(roomId).emit("user-left", {
    id: socket.id,
  });

  if (room.size === 0) {
    rooms.delete(roomId);
  }

  console.log(
    `User left room=${roomId}, socket=${socket.id}, remaining=${room.size}`
  );
}

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("join-room", ({ roomId, name }) => {
    if (!roomId) {
      roomId = "studio";
    }

    /*
      If this socket was already in another room, clean it first.
    */
    if (socket.data.roomId && socket.data.roomId !== roomId) {
      removeUserFromRoom(socket);
      socket.leave(socket.data.roomId);
    }

    socket.data.roomId = roomId;
    socket.data.name = name || "Participant";

    const room = getRoom(roomId);

    const initialState = {
      muted: false,
      cameraOff: false,
      isSpeaking: false,
      volume: 0,
      lipOpen: false,
      leaning: false,
      gazingSpeaker: false,
      speakingMs: 0,
    };

    /*
      Existing users are sent to the new user.
      The new user will create WebRTC offers to them.
    */
    const existingUsers = Array.from(room.values()).map((user) => ({
      id: user.id,
      name: user.name,
      state: user.state,
    }));

    room.set(socket.id, {
      id: socket.id,
      name: socket.data.name,
      state: initialState,
    });

    socket.join(roomId);

    socket.emit("joined", {
      id: socket.id,
      users: existingUsers,
    });

    socket.to(roomId).emit("user-joined", {
      id: socket.id,
      name: socket.data.name,
      state: initialState,
    });

    console.log(
      `User joined room=${roomId}, socket=${socket.id}, name=${socket.data.name}, total=${room.size}`
    );
  });

  /*
    WebRTC signaling:
    offer / answer / ice candidate
  */
  socket.on("signal", ({ to, type, sdp, candidate }) => {
    if (!to || !type) return;

    io.to(to).emit("signal", {
      from: socket.id,
      type,
      sdp,
      candidate,
    });
  });

  /*
    Realtime participant state:
    speaking, muted, lipOpen, leaning, gazingSpeaker, speakingMs...
  */
  socket.on("user-state", (state) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const user = room.get(socket.id);
    if (!user) return;

    user.state = {
      ...user.state,
      ...state,
    };

    socket.to(roomId).emit("user-state", {
      id: socket.id,
      state: user.state,
    });
  });

  /*
    Optional manual leave.
    Your current app.js may not use this yet,
    but it is safe to keep.
  */
  socket.on("leave-room", () => {
    removeUserFromRoom(socket);

    if (socket.data.roomId) {
      socket.leave(socket.data.roomId);
    }

    socket.data.roomId = null;
  });

  socket.on("disconnect", (reason) => {
    console.log("Socket disconnected:", socket.id, reason);
    removeUserFromRoom(socket);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`InBetween server running on port ${PORT}`);
});

app.get("/config", (req, res) => {
  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  if (
    process.env.TURN_URL &&
    process.env.TURN_USERNAME &&
    process.env.TURN_CREDENTIAL
  ) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }

  res.json({ iceServers });
});
