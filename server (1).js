const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.get("/", (_, res) => res.send("Tetris Battle Server running"));

// rooms: { roomId: { players, started, host, eliminationOrder } }
const rooms = {};

const getRoomList = () =>
  Object.entries(rooms).map(([id, r]) => ({
    id,
    playerCount: Object.keys(r.players).length,
    started: r.started,
    host: r.host,
  }));

function leaveRoom(socket) {
  const roomId = socket.roomId;
  if (!roomId || !rooms[roomId]) return;

  delete rooms[roomId].players[socket.id];
  socket.leave(roomId);
  socket.roomId = null;

  const room = rooms[roomId];
  const playerCount = Object.keys(room.players).length;

  if (playerCount === 0) {
    delete rooms[roomId];
  } else {
    // Host ayrıldıysa yeni host ata
    if (room.host === socket.id) {
      room.host = Object.keys(room.players)[0];
    }

    // Oyun sırasında ayrıldıysa elendi say
    if (room.started) {
      const alive = Object.values(room.players).filter(p => p.alive);
      io.to(roomId).emit("player_eliminated", { id: socket.id });

      if (alive.length <= 1) {
        const winner = alive[0];
        if (winner) {
          room.players[winner.id].rank = 1;
          io.to(roomId).emit("game_end", {
            winner: winner.id,
            players: room.players,
          });
        }
        room.started = false;
        Object.values(room.players).forEach(p => { p.alive = true; p.score = 0; p.board = null; p.rank = null; });
      }
    }

    io.to(roomId).emit("room_update", {
      players: room.players,
      host: room.host,
      started: room.started,
    });
  }

  io.emit("room_list", getRoomList());
}

io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  socket.on("get_rooms", () => {
    socket.emit("room_list", getRoomList());
  });

  socket.on("join_room", ({ roomId, nickname }) => {
    const room = rooms[roomId];
    if (room && room.started) { socket.emit("error_msg", "Oyun zaten başladı."); return; }
    if (room && Object.keys(room.players).length >= 8) { socket.emit("error_msg", "Oda dolu (max 8)."); return; }

    if (socket.roomId) leaveRoom(socket);

    if (!rooms[roomId]) {
      rooms[roomId] = { players: {}, started: false, host: socket.id, eliminationOrder: [] };
    }

    rooms[roomId].players[socket.id] = {
      id: socket.id,
      nickname: nickname || "Oyuncu",
      alive: true,
      score: 0,
      board: null,
      rank: null,
    };

    socket.roomId = roomId;
    socket.join(roomId);

    io.to(roomId).emit("room_update", {
      players: rooms[roomId].players,
      host: rooms[roomId].host,
      started: rooms[roomId].started,
    });

    io.emit("room_list", getRoomList());
  });

  socket.on("leave_room", () => leaveRoom(socket));

  socket.on("start_game", () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    if (room.host !== socket.id) { socket.emit("error_msg", "Sadece oda sahibi başlatabilir."); return; }
    if (Object.keys(room.players).length < 2) { socket.emit("error_msg", "En az 2 oyuncu gerekli."); return; }

    room.started = true;
    room.eliminationOrder = [];
    Object.values(room.players).forEach(p => { p.alive = true; p.score = 0; p.board = null; p.rank = null; });

    io.to(socket.roomId).emit("game_start", { players: room.players });
    io.emit("room_list", getRoomList());
  });

  // Oyuncu periyodik board+skor güncellemesi gönderir
  socket.on("game_update", ({ score, board }) => {
    const room = rooms[socket.roomId];
    if (!room || !room.started || !room.players[socket.id]) return;
    room.players[socket.id].score = score;
    room.players[socket.id].board = board;
    socket.to(socket.roomId).emit("player_update", { id: socket.id, score, board });
  });

  // Oyuncu elendi
  socket.on("game_over", ({ score }) => {
    const room = rooms[socket.roomId];
    if (!room || !room.started || !room.players[socket.id]) return;

    room.players[socket.id].alive = false;
    room.players[socket.id].score = score;

    const totalPlayers = Object.keys(room.players).length;
    const rank = totalPlayers - room.eliminationOrder.length;
    room.players[socket.id].rank = rank;
    room.eliminationOrder.push(socket.id);

    io.to(socket.roomId).emit("player_eliminated", { id: socket.id, rank });

    const alive = Object.values(room.players).filter(p => p.alive);
    if (alive.length <= 1) {
      const winner = alive[0];
      if (winner) {
        room.players[winner.id].rank = 1;
        io.to(socket.roomId).emit("game_end", {
          winner: winner.id,
          players: room.players,
        });
      }
      room.started = false;
    }

    io.emit("room_list", getRoomList());
  });

  // Oyunu tekrar başlat (host)
  socket.on("restart_game", () => {
    const room = rooms[socket.roomId];
    if (!room || room.host !== socket.id) return;
    if (Object.keys(room.players).length < 2) { socket.emit("error_msg", "En az 2 oyuncu gerekli."); return; }

    room.started = true;
    room.eliminationOrder = [];
    Object.values(room.players).forEach(p => { p.alive = true; p.score = 0; p.board = null; p.rank = null; });

    io.to(socket.roomId).emit("game_start", { players: room.players });
    io.emit("room_list", getRoomList());
  });

  socket.on("disconnect", () => {
    console.log("disconnected:", socket.id);
    leaveRoom(socket);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
