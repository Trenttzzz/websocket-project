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

// Routes
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');

// Initialization
const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);

// Custom event emitter for room deletion
const EventEmitter = require('events');
const roomEvents = new EventEmitter();

// Room deleted event listener
roomEvents.on('room:deleted', (roomId) => {
  io.to(roomId).emit('room:deleted', { 
    roomId,
    message: 'This room has been deleted by the creator'
  });
  
  // Disconnect all users from the room
  io.in(roomId).socketsLeave(roomId);
});

// Create HTTP(S) server
let server;
const sslOptions = getSSLOptions();

// Selalu gunakan HTTPS untuk mengaktifkan WSS
if (sslOptions) {
  server = https.createServer(sslOptions, app);
  console.log('Server running with SSL/TLS - WSS enabled');
} else {
  console.error('SSL certificates not found! WSS requires HTTPS.');
  console.log('Looking for certificates at certificates/server.key and certificates/server.crt');
  server = http.createServer(app);
  console.log('Warning: Server running without SSL/TLS - WSS not available, falling back to WS');
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
      
      // Send welcome message (only to the joining user)
      const welcomeMessage = new Message({
        roomId,
        userId: null,
        text: `Welcome to ${room.name}! This is a secure chat room. Please be respectful to other users.`,
        type: 'announcement'
      });
      await welcomeMessage.save();
      
      socket.emit('message:new', {
        id: welcomeMessage._id,
        roomId,
        userId: null,
        username: 'System',
        text: welcomeMessage.text,
        type: welcomeMessage.type,
        createdAt: welcomeMessage.createdAt
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
module.exports = { app, server, io, broadcastAnnouncement, roomEvents };