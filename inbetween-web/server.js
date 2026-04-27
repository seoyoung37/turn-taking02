const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { AccessToken } = require("livekit-server-sdk");

const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

function sanitizeRoomName(value) {
  return (
    String(value || "studio")
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .slice(0, 64) || "studio"
  );
}

function sanitizeName(value) {
  return String(value || "Participant").trim().slice(0, 50) || "Participant";
}

app.get("/token", async (req, res) => {
  try {
    const livekitUrl = process.env.LIVEKIT_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;

    if (!livekitUrl || !apiKey || !apiSecret) {
      return res.status(500).json({
        error:
          "Missing LIVEKIT_URL, LIVEKIT_API_KEY, or LIVEKIT_API_SECRET in Railway Variables.",
      });
    }

    const roomName = sanitizeRoomName(req.query.room);
    const participantName = sanitizeName(req.query.name);

    const identity =
      String(req.query.identity || "").trim() ||
      `${participantName}-${crypto.randomUUID().slice(0, 8)}`;

    const token = new AccessToken(apiKey, apiSecret, {
      identity,
      name: participantName,
      ttl: "6h",
    });

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const jwt = await token.toJwt();

    res.json({
      url: livekitUrl,
      token: jwt,
      identity,
      name: participantName,
      room: roomName,
    });
  } catch (error) {
    console.error("Token error:", error);
    res.status(500).json({ error: "Failed to create LiveKit token." });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`InBetween LiveKit server running on port ${PORT}`);
});