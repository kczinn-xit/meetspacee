const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
  cors: {
    origin: "*",
  },
});

// Room state: Map<roomId, Map<socketId, { name, micOn, camOn, handRaised, isScreenSharing }>>
const rooms = new Map();

// Static files first
app.use(express.static("public"));

// Routes
app.get("/", (req, res) => {
  res.sendFile("index.html", { root: __dirname + "/public" });
});

app.get("/room/:id", (req, res) => {
  res.sendFile("room.html", { root: __dirname + "/public" });
});

app.get("/api/new-room", (req, res) => {
  res.json({ roomId: generateRoomId() });
});

// Socket.io
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);
  const MEETING_PASSWORD = "123forfivesix";

  socket.on("join-room", ({ roomId, name, password }) => {
    console.log("join-room:", { roomId, name }, "socket:", socket.id);

    if (password !== MEETING_PASSWORD) {
      socket.emit("join-error", "Incorrect password");
      socket.disconnect(true);
      return;
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.displayName = name;

    const peers = getOrCreateRoom(roomId);
    peers.set(socket.id, {
      name,
      micOn: true,
      camOn: true,
      handRaised: false,
    });
    console.log("Room", roomId, "peers:", Array.from(peers.keys()));

    // Send existing peers to joiner (socketIds only, no own id)
    const existing = [];
    for (const [sid] of peers) {
      if (sid !== socket.id) {
        existing.push(sid);
      }
    }
    socket.emit("room-peers", existing);

    // Notify existing peers
    socket.to(roomId).emit("peer-joined", {
      socketId: socket.id,
      name,
    });

    io.to(roomId).emit("participants-update", peersToSnapshot(peers));
  });

  socket.on("offer", ({ targetId, offer }) => {
    socket.to(targetId).emit("offer", {
      offer,
      senderId: socket.id,
    });
  });

  socket.on("answer", ({ targetId, answer }) => {
    socket.to(targetId).emit("answer", {
      answer,
      senderId: socket.id,
    });
  });

  socket.on("ice-candidate", ({ targetId, candidate }) => {
    socket.to(targetId).emit("ice-candidate", {
      candidate,
      senderId: socket.id,
    });
  });

  socket.on("chat-message", ({ roomId, text, name }) => {
    const ts = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    io.to(roomId).emit("chat-message", { text, name, timestamp: ts });
  });

  socket.on("media-state", ({ roomId, micOn, camOn }) => {
    socket.micOn = micOn;
    socket.camOn = camOn;
    const peers = rooms.get(roomId);
    if (peers && peers.has(socket.id)) {
      peers.get(socket.id).micOn = micOn;
      peers.get(socket.id).camOn = camOn;
    }
    io.to(roomId).emit("participants-update", peersToSnapshot(peers));
    socket.to(roomId).emit("media-state", {
      socketId: socket.id,
      micOn,
      camOn,
    });
  });

  socket.on("raise-hand", ({ roomId, raised }) => {
    const peers = rooms.get(roomId);
    if (peers && peers.has(socket.id)) {
      peers.get(socket.id).handRaised = raised;
    }
    io.to(roomId).emit("participants-update", peersToSnapshot(peers));
    socket.to(roomId).emit("raise-hand", { socketId: socket.id, raised });
  });

  socket.on("screenshare-update", ({ roomId, isScreenSharing }) => {
    const peers = rooms.get(roomId);
    if (peers && peers.has(socket.id)) {
      peers.get(socket.id).isScreenSharing = isScreenSharing;
    }
    socket.to(roomId).emit("screenshare-update", { socketId: socket.id, isScreenSharing });
  });

  socket.on("disconnect", () => {
    const roomId = socket.roomId;
    if (roomId) {
      const peers = rooms.get(roomId);
      if (peers) {
        peers.delete(socket.id);
        io.to(roomId).emit("participants-update", peersToSnapshot(peers));
        if (peers.size === 0) {
          rooms.delete(roomId);
        }
      }
    }
    cleanupSocket(socket.id);
  });
});

function generateRoomId() {
  return uuidv4().slice(0, 8).toUpperCase();
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }
  return rooms.get(roomId);
}

function peersToSnapshot(peers) {
  return Array.from(peers.entries()).map(([socketId, data]) => ({
    socketId,
    name: data.name,
    micOn: data.micOn,
    camOn: data.camOn,
    handRaised: data.handRaised,
    isScreenSharing: data.isScreenSharing || false,
  }));
}

function cleanupSocket(socketId) {
  // Clean up any stale references (peers are cleaned up in disconnect handler)
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`MeetSpace server running on http://localhost:${PORT}`);
});
