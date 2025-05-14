require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const https = require('https');
const http = require('http');
const path = require('path');
const cors = require('cors');
const socketIo = require('socket.io');
const { getSSLOptions, socketAuth } = require('./utils/security');
const { initializeHeartbeat, setupInactiveConnectionsMonitor } = require('./utils/heartbeat');
const Room = require('./models/Room');
const User = require('./models/User');
const Message = require('./models/Message');
const { startGrpcServer } = require('./grpc/grpcServer'); // Import server gRPC

// Routes
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');

// Initialization
const app = express();
const PORT = process.env.PORT || 3000;
const GRPC_PORT = process.env.GRPC_PORT || 50051;
const isProduction = process.env.NODE_ENV === 'production';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);

// Create HTTP(S) server
let server;
const sslOptions = getSSLOptions();

if (isProduction && sslOptions) {
  server = https.createServer(sslOptions, app);
  console.log('Server running with SSL/TLS');
} else {
  server = http.createServer(app);
  console.log('Server running without SSL/TLS (development mode)');
}

// Socket.IO setup
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Socket.IO authentication middleware
io.use(socketAuth);

// Socket.IO connection handling
io.on('connection', async (socket) => {
  console.log(`User connected: ${socket.id} (${socket.user.username})`);
  
  // Initialize heartbeat mechanism
  initializeHeartbeat(socket, io);
  
  // Handle joining a room
  socket.on('room:join', async ({ roomId }) => {
    try {
      // Find the room
      const room = await Room.findById(roomId);
      if (!room) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }
      
      // Check connection limit
      if (room.hasReachedConnectionLimit()) {
        socket.emit('error', { message: 'Room is full' });
        return;
      }
      
      // Add user to room
      await room.addConnection(socket.user.id, socket.id);
      
      // Join the socket.io room
      socket.join(roomId);
      
      // Notify all users in the room
      io.to(roomId).emit('user:joined', {
        userId: socket.user.id,
        username: socket.user.username,
        timestamp: new Date()
      });
      
      // Send room info back to user
      socket.emit('room:joined', {
        roomId,
        name: room.name,
        activeUsers: room.activeConnections.length
      });
      
      // Create system message for join
      const joinMessage = new Message({
        roomId,
        userId: socket.user.id,
        text: `${socket.user.username} has joined the room`,
        type: 'system'
      });
      await joinMessage.save();
      
      // Broadcast join message
      io.to(roomId).emit('message:new', {
        id: joinMessage._id,
        roomId,
        userId: socket.user.id,
        username: socket.user.username,
        text: joinMessage.text,
        type: joinMessage.type,
        createdAt: joinMessage.createdAt
      });
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });
  
  // Handle leaving a room
  socket.on('room:leave', async ({ roomId }) => {
    try {
      // Find the room
      const room = await Room.findById(roomId);
      if (room) {
        // Remove user from room
        await room.removeConnection(socket.id);
        
        // Leave the socket.io room
        socket.leave(roomId);
        
        // Notify all users in the room
        io.to(roomId).emit('user:left', {
          userId: socket.user.id,
          username: socket.user.username,
          timestamp: new Date()
        });
        
        // Create system message for leave
        const leaveMessage = new Message({
          roomId,
          userId: socket.user.id,
          text: `${socket.user.username} has left the room`,
          type: 'system'
        });
        await leaveMessage.save();
        
        // Broadcast leave message
        io.to(roomId).emit('message:new', {
          id: leaveMessage._id,
          roomId,
          userId: socket.user.id,
          username: socket.user.username,
          text: leaveMessage.text,
          type: leaveMessage.type,
          createdAt: leaveMessage.createdAt
        });
      }
    } catch (error) {
      console.error('Error leaving room:', error);
    }
  });
  
  // Handle sending a message
  socket.on('message:send', async ({ roomId, text }) => {
    try {
      // Check if user is in room
      const room = await Room.findById(roomId);
      const userConnection = room?.activeConnections.find(
        conn => conn.socketId === socket.id
      );
      
      if (!room || !userConnection) {
        socket.emit('error', { message: 'You are not in this room' });
        return;
      }
      
      // Create new message
      const message = new Message({
        roomId,
        userId: socket.user.id,
        text,
        type: 'user'
      });
      await message.save();
      
      // Get user details
      const user = await User.findById(socket.user.id);
      
      // Broadcast the message
      io.to(roomId).emit('message:new', {
        id: message._id,
        roomId,
        userId: socket.user.id,
        username: user.username,
        text: message.text,
        type: message.type,
        createdAt: message.createdAt
      });
    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });
  
  // WebSocket Speed Test
  socket.on('speed:test', ({ timestamp, payload }) => {
    const receivedTime = Date.now();
    const latency = receivedTime - timestamp;
    
    // Send response back with latency measurements
    socket.emit('speed:result', {
      sentTimestamp: timestamp,
      receivedTimestamp: receivedTime,
      responseTimestamp: Date.now(),
      latency,
      payloadSize: JSON.stringify(payload).length
    });
  });
  
  // Handle disconnect
  socket.on('disconnect', async () => {
    try {
      console.log(`User disconnected: ${socket.id} (${socket.user.username})`);
      
      // Find all rooms the user was in and remove them
      const rooms = await Room.find({
        'activeConnections.socketId': socket.id
      });
      
      for (const room of rooms) {
        await room.removeConnection(socket.id);
        
        // Create system message for disconnect
        const disconnectMessage = new Message({
          roomId: room._id,
          userId: socket.user.id,
          text: `${socket.user.username} has disconnected`,
          type: 'system'
        });
        await disconnectMessage.save();
        
        // Broadcast disconnect message
        io.to(room._id).emit('message:new', {
          id: disconnectMessage._id,
          roomId: room._id,
          userId: socket.user.id,
          username: socket.user.username,
          text: disconnectMessage.text,
          type: disconnectMessage.type,
          createdAt: disconnectMessage.createdAt
        });
        
        io.to(room._id).emit('user:left', {
          userId: socket.user.id,
          username: socket.user.username,
          timestamp: new Date()
        });
      }
    } catch (error) {
      console.error('Error handling disconnect:', error);
    }
  });
});

// Setup server-initiated messages (announcements)
const broadcastAnnouncement = async (message, roomId = null) => {
  try {
    let rooms = [];
    
    if (roomId) {
      const room = await Room.findById(roomId);
      if (room) rooms.push(room);
    } else {
      rooms = await Room.find();
    }
    
    for (const room of rooms) {
      // Create announcement message
      const announcement = new Message({
        roomId: room._id,
        userId: null,
        text: message,
        type: 'announcement'
      });
      await announcement.save();
      
      // Broadcast to the room
      io.to(room._id).emit('message:new', {
        id: announcement._id,
        roomId: room._id,
        userId: null,
        username: 'System',
        text: announcement.text,
        type: announcement.type,
        createdAt: announcement.createdAt
      });
    }
    
    return true;
  } catch (error) {
    console.error('Error broadcasting announcement:', error);
    return false;
  }
};

// Schedule announcements example (comment this out if not needed)
// setInterval(() => {
//   broadcastAnnouncement('This is an automated system message. Server is running normally.');
// }, 1000 * 60 * 30); // Every 30 minutes

// Setup inactive connection monitor
const inactiveConnectionsInterval = setupInactiveConnectionsMonitor(io);

// Connect to MongoDB with retry logic
const connectWithRetry = () => {
  console.log('Attempting to connect to MongoDB...');
  // Note: If connection fails, ensure MongoDB service is running with: 'sudo systemctl start mongod'
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => {
      console.log('Connected to MongoDB');
      
      // Start the server once MongoDB is connected
      server.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
      });

      // Start gRPC server
      startGrpcServer(GRPC_PORT);
    })
    .catch(err => {
      console.error('MongoDB connection error:', err);
      console.log('Retrying connection in 5 seconds...');
      // Try to reconnect after 5 seconds
      setTimeout(connectWithRetry, 5000);
    });
};

// Initialize MongoDB connection with retry mechanism
connectWithRetry();

// Root endpoint to serve the app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Add API endpoint for sending announcements
app.post('/api/admin/announcement', async (req, res) => {
  try {
    const { message, roomId } = req.body;
    const result = await broadcastAnnouncement(message, roomId);
    
    if (result) {
      res.json({ success: true, message: 'Announcement sent successfully' });
    } else {
      res.status(500).json({ success: false, message: 'Failed to send announcement' });
    }
  } catch (error) {
    console.error('Announcement API error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Add API endpoints for gRPC operations
app.post('/api/grpc/join-room', async (req, res) => {
  try {
    const { roomId } = req.body;
    const token = req.header('Authorization').replace('Bearer ', '');
    
    // Interact with gRPC client via server-side proxy
    const { chatServiceImpl } = require('./grpc/grpcServer');
    
    chatServiceImpl.JoinRoom(
      { request: { token, room_id: roomId } },
      (err, response) => {
        if (err || !response.success) {
          return res.status(400).json({
            success: false,
            error_message: err?.message || response?.error_message || 'Failed to join room'
          });
        }
        
        res.json({
          success: true,
          room: response.room
        });
      }
    );
  } catch (error) {
    console.error('gRPC join room error:', error);
    res.status(500).json({ success: false, error_message: 'Server error' });
  }
});

app.post('/api/grpc/leave-room', async (req, res) => {
  try {
    const { roomId } = req.body;
    const token = req.header('Authorization').replace('Bearer ', '');
    
    // Interact with gRPC client via server-side proxy
    const { chatServiceImpl } = require('./grpc/grpcServer');
    
    chatServiceImpl.LeaveRoom(
      { request: { token, room_id: roomId } },
      (err, response) => {
        if (err || !response.success) {
          return res.status(400).json({
            success: false,
            error_message: err?.message || response?.error_message || 'Failed to leave room'
          });
        }
        
        res.json({ success: true });
      }
    );
  } catch (error) {
    console.error('gRPC leave room error:', error);
    res.status(500).json({ success: false, error_message: 'Server error' });
  }
});

app.post('/api/grpc/send-message', async (req, res) => {
  try {
    const { roomId, text } = req.body;
    const token = req.header('Authorization').replace('Bearer ', '');
    
    // Interact with gRPC client via server-side proxy
    const { chatServiceImpl } = require('./grpc/grpcServer');
    
    chatServiceImpl.SendMessage(
      { request: { token, room_id: roomId, text } },
      (err, response) => {
        if (err || !response.success) {
          return res.status(400).json({
            success: false,
            error_message: err?.message || response?.error_message || 'Failed to send message'
          });
        }
        
        res.json({
          success: true,
          message: response.message
        });
      }
    );
  } catch (error) {
    console.error('gRPC send message error:', error);
    res.status(500).json({ success: false, error_message: 'Server error' });
  }
});

app.post('/api/grpc/speed-test', async (req, res) => {
  try {
    const { timestamp, payload } = req.body;
    const token = req.header('Authorization').replace('Bearer ', '');
    
    // Interact with gRPC client via server-side proxy
    const { chatServiceImpl } = require('./grpc/grpcServer');
    
    chatServiceImpl.SpeedTest(
      { 
        request: { 
          token, 
          timestamp: timestamp.toString(),
          payload: Buffer.from(payload)
        }
      },
      (err, response) => {
        if (err) {
          return res.status(400).json({
            success: false,
            error_message: err.message || 'Speed test failed'
          });
        }
        
        res.json({
          success: true,
          sent_timestamp: parseInt(response.sent_timestamp),
          received_timestamp: parseInt(response.received_timestamp),
          response_timestamp: parseInt(response.response_timestamp),
          latency: parseInt(response.latency),
          payload_size: response.payload_size
        });
      }
    );
  } catch (error) {
    console.error('gRPC speed test error:', error);
    res.status(500).json({ success: false, error_message: 'Server error' });
  }
});

// Server-Sent Events (SSE) endpoint for real-time gRPC streaming
app.get('/api/grpc/stream', (req, res) => {
  const roomId = req.query.roomId;
  const token = req.query.token;
  
  if (!roomId || !token) {
    return res.status(400).json({
      success: false,
      error_message: 'Room ID and token are required'
    });
  }
  
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Send initial connection message
  res.write(`data: ${JSON.stringify({ event_type: 'connected', room_id: roomId })}\n\n`);
  
  // Setup message queue for this client
  const messageQueue = [];
  const clientId = Date.now();
  
  // Get gRPC service implementation
  const { chatServiceImpl } = require('./grpc/grpcServer');
  
  // Add listener for room events
  const listener = (data) => {
    if (data.room_id === roomId) {
      messageQueue.push(data);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };
  
  // Add this client to the room's listeners
  if (!chatServiceImpl.eventListeners) {
    chatServiceImpl.eventListeners = new Map();
  }
  
  if (!chatServiceImpl.eventListeners.has(roomId)) {
    chatServiceImpl.eventListeners.set(roomId, new Map());
  }
  
  chatServiceImpl.eventListeners.get(roomId).set(clientId, listener);
  
  // Handle client disconnect
  req.on('close', () => {
    if (chatServiceImpl.eventListeners && 
        chatServiceImpl.eventListeners.has(roomId) &&
        chatServiceImpl.eventListeners.get(roomId).has(clientId)) {
      chatServiceImpl.eventListeners.get(roomId).delete(clientId);
      
      // Clean up empty maps
      if (chatServiceImpl.eventListeners.get(roomId).size === 0) {
        chatServiceImpl.eventListeners.delete(roomId);
      }
    }
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  clearInterval(inactiveConnectionsInterval);
  
  try {
    await mongoose.disconnect();
    console.log('MongoDB disconnected');
    
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

// Export for testing
module.exports = { app, server, io, broadcastAnnouncement };