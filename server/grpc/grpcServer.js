const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Room = require('../models/Room');
const Message = require('../models/Message');

// Load the protobuf definition
const PROTO_PATH = path.join(__dirname, 'chat.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});

const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
const chatProto = protoDescriptor.chat;

// Active message streams
const activeStreams = new Map();

// Event listeners for SSE integration
const eventListeners = new Map();

// Auth verification function
const verifyToken = async (token) => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return { userId: decoded.id, username: decoded.username };
  } catch (error) {
    return null;
  }
};

// Function to broadcast events to SSE clients
const broadcastEvent = (roomId, event) => {
  if (eventListeners.has(roomId)) {
    const listeners = eventListeners.get(roomId);
    listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (error) {
        console.error('Error broadcasting to SSE listener:', error);
      }
    });
  }
};

// gRPC service implementation
const chatServiceImpl = {
  // Authentication
  Login: async (call, callback) => {
    try {
      const { username, password } = call.request;
      
      // Find user
      const user = await User.findOne({ username });
      if (!user) {
        return callback(null, {
          success: false,
          error_message: 'Invalid username or password'
        });
      }
      
      // Check password
      const isMatch = await user.comparePassword(password);
      if (!isMatch) {
        return callback(null, {
          success: false,
          error_message: 'Invalid username or password'
        });
      }
      
      // Update last active
      user.lastActive = Date.now();
      await user.save();
      
      // Generate token
      const token = user.generateAuthToken();
      
      callback(null, {
        success: true,
        token,
        user: {
          id: user._id.toString(),
          username: user.username
        }
      });
    } catch (error) {
      console.error('Login error:', error);
      callback(null, {
        success: false,
        error_message: 'Server error during login'
      });
    }
  },
  
  // Room operations
  ListRooms: async (call, callback) => {
    try {
      const { token } = call.request;
      
      // Verify token
      const authUser = await verifyToken(token);
      if (!authUser) {
        return callback(null, {
          success: false,
          error_message: 'Authentication required'
        });
      }
      
      // Get rooms
      const rooms = await Room.find()
        .populate('createdBy', 'username')
        .select('name description createdAt activeConnections maxConnections');
      
      const formattedRooms = rooms.map(room => ({
        id: room._id.toString(),
        name: room.name,
        description: room.description,
        created_by: room.createdBy ? room.createdBy.username : 'Unknown',
        created_at: new Date(room.createdAt).getTime(),
        active_connections: room.activeConnections.length,
        max_connections: room.maxConnections,
        is_full: room.activeConnections.length >= room.maxConnections
      }));
      
      callback(null, {
        success: true,
        rooms: formattedRooms
      });
    } catch (error) {
      console.error('List rooms error:', error);
      callback(null, {
        success: false,
        error_message: 'Server error'
      });
    }
  },
  
  JoinRoom: async (call, callback) => {
    try {
      const { token, room_id } = call.request;
      
      // Verify token
      const authUser = await verifyToken(token);
      if (!authUser) {
        return callback(null, {
          success: false,
          error_message: 'Authentication required'
        });
      }
      
      // Find room
      const room = await Room.findById(room_id)
        .populate('createdBy', 'username');
      
      if (!room) {
        return callback(null, {
          success: false,
          error_message: 'Room not found'
        });
      }
      
      // Check connection limit
      if (room.hasReachedConnectionLimit()) {
        return callback(null, {
          success: false,
          error_message: 'Room is full'
        });
      }
      
      // Add user to room (using a virtual connection ID for gRPC)
      const grpcConnectionId = `grpc-${authUser.userId}-${Date.now()}`;
      await room.addConnection(authUser.userId, grpcConnectionId);
      
      // Create system message
      const joinMessage = new Message({
        roomId: room_id,
        userId: authUser.userId,
        text: `${authUser.username} has joined the room via gRPC`,
        type: 'system'
      });
      await joinMessage.save();
      
      // Prepare event data
      const eventData = {
        event_type: 'user_joined',
        user: {
          id: authUser.userId,
          username: authUser.username
        },
        room_id: room_id,
        timestamp: Date.now()
      };

      // Broadcast to SSE clients
      broadcastEvent(room_id, eventData);
      
      // Also broadcast the system message
      const messageEventData = {
        event_type: 'new_message',
        message: {
          id: joinMessage._id.toString(),
          roomId: room_id,
          userId: authUser.userId,
          username: authUser.username,
          text: joinMessage.text,
          type: 'system',
          createdAt: joinMessage.createdAt
        },
        room_id: room_id,
        timestamp: Date.now()
      };
      
      broadcastEvent(room_id, messageEventData);
      
      callback(null, {
        success: true,
        room: {
          id: room._id.toString(),
          name: room.name,
          description: room.description,
          created_by: room.createdBy ? room.createdBy.username : 'Unknown',
          created_at: new Date(room.createdAt).getTime(),
          active_connections: room.activeConnections.length,
          max_connections: room.maxConnections
        }
      });
    } catch (error) {
      console.error('Join room error:', error);
      callback(null, {
        success: false,
        error_message: 'Server error'
      });
    }
  },
  
  LeaveRoom: async (call, callback) => {
    try {
      const { token, room_id } = call.request;
      
      // Verify token
      const authUser = await verifyToken(token);
      if (!authUser) {
        return callback(null, {
          success: false,
          error_message: 'Authentication required'
        });
      }
      
      // Find room
      const room = await Room.findById(room_id);
      if (!room) {
        return callback(null, {
          success: false,
          error_message: 'Room not found'
        });
      }
      
      // Remove user connection (find by userId)
      const connectionToRemove = room.activeConnections.find(
        conn => conn.userId.toString() === authUser.userId
      );
      
      if (connectionToRemove) {
        await room.removeConnection(connectionToRemove.socketId);
        
        // Create system message
        const leaveMessage = new Message({
          roomId: room_id,
          userId: authUser.userId,
          text: `${authUser.username} has left the room`,
          type: 'system'
        });
        await leaveMessage.save();
        
        // Prepare event data
        const eventData = {
          event_type: 'user_left',
          user: {
            id: authUser.userId,
            username: authUser.username
          },
          room_id: room_id,
          timestamp: Date.now()
        };
        
        // Broadcast to SSE clients
        broadcastEvent(room_id, eventData);
        
        // Also broadcast the system message
        const messageEventData = {
          event_type: 'new_message',
          message: {
            id: leaveMessage._id.toString(),
            roomId: room_id,
            userId: authUser.userId,
            username: authUser.username,
            text: leaveMessage.text,
            type: 'system',
            createdAt: leaveMessage.createdAt
          },
          room_id: room_id,
          timestamp: Date.now()
        };
        
        broadcastEvent(room_id, messageEventData);
      }
      
      callback(null, {
        success: true
      });
    } catch (error) {
      console.error('Leave room error:', error);
      callback(null, {
        success: false,
        error_message: 'Server error'
      });
    }
  },
  
  // Message operations
  SendMessage: async (call, callback) => {
    try {
      const { token, room_id, text } = call.request;
      
      // Verify token
      const authUser = await verifyToken(token);
      if (!authUser) {
        return callback(null, {
          success: false,
          error_message: 'Authentication required'
        });
      }
      
      // Find room
      const room = await Room.findById(room_id);
      if (!room) {
        return callback(null, {
          success: false,
          error_message: 'Room not found'
        });
      }
      
      // Check if user is in room
      const userConnection = room.activeConnections.find(
        conn => conn.userId.toString() === authUser.userId
      );
      
      if (!userConnection) {
        return callback(null, {
          success: false,
          error_message: 'You are not in this room'
        });
      }
      
      // Create message
      const message = new Message({
        roomId: room_id,
        userId: authUser.userId,
        text,
        type: 'user'
      });
      await message.save();
      
      // Get user details
      const user = await User.findById(authUser.userId);
      
      // Prepare message info for response
      const messageInfo = {
        id: message._id.toString(),
        room_id: message.roomId.toString(),
        user: {
          id: user._id.toString(),
          username: user.username
        },
        text: message.text,
        type: message.type,
        created_at: new Date(message.createdAt).getTime()
      };
      
      // Broadcast to SSE clients
      broadcastEvent(room_id, {
        event_type: 'new_message',
        message: {
          id: message._id.toString(),
          roomId: room_id,
          userId: user._id.toString(),
          username: user.username,
          text: message.text,
          type: message.type,
          createdAt: message.createdAt
        },
        room_id,
        timestamp: Date.now()
      });
      
      callback(null, {
        success: true,
        message: messageInfo
      });
    } catch (error) {
      console.error('Send message error:', error);
      callback(null, {
        success: false,
        error_message: 'Server error'
      });
    }
  },
  
  GetMessages: async (call, callback) => {
    try {
      const { token, room_id, limit = 50, skip = 0 } = call.request;
      
      // Verify token
      const authUser = await verifyToken(token);
      if (!authUser) {
        return callback(null, {
          success: false,
          error_message: 'Authentication required'
        });
      }
      
      // Find room
      const room = await Room.findById(room_id);
      if (!room) {
        return callback(null, {
          success: false,
          error_message: 'Room not found'
        });
      }
      
      // Get messages
      const messages = await Message.findByRoom(room_id, parseInt(limit), parseInt(skip));
      
      const formattedMessages = await Promise.all(messages.map(async (message) => {
        let username = 'System';
        
        if (message.userId) {
          const user = await User.findById(message.userId);
          if (user) {
            username = user.username;
          }
        }
        
        return {
          id: message._id.toString(),
          room_id: message.roomId.toString(),
          user: {
            id: message.userId ? message.userId.toString() : '',
            username
          },
          text: message.text,
          type: message.type,
          created_at: new Date(message.createdAt).getTime()
        };
      }));
      
      callback(null, {
        success: true,
        messages: formattedMessages
      });
    } catch (error) {
      console.error('Get messages error:', error);
      callback(null, {
        success: false,
        error_message: 'Server error'
      });
    }
  },
  
  // Speed test for performance comparison
  SpeedTest: (call, callback) => {
    try {
      const { timestamp, payload } = call.request;
      const receivedTime = Date.now();
      const latency = receivedTime - parseInt(timestamp);
      
      callback(null, {
        sent_timestamp: timestamp,
        received_timestamp: receivedTime.toString(),
        response_timestamp: Date.now().toString(),
        latency: latency.toString(),
        payload_size: payload.length
      });
    } catch (error) {
      console.error('Speed test error:', error);
      callback(null, {
        sent_timestamp: call.request.timestamp || '0',
        received_timestamp: '0',
        response_timestamp: Date.now().toString(),
        latency: '-1',
        payload_size: 0
      });
    }
  },
  
  // Streaming for real-time messages
  MessageStream: async (call) => {
    try {
      const { token, room_id } = call.request;
      
      // Verify token
      const authUser = await verifyToken(token);
      if (!authUser) {
        call.write({
          event_type: 'error',
          message: { text: 'Authentication required' },
          timestamp: Date.now()
        });
        call.end();
        return;
      }
      
      // Store stream reference for broadcasting
      if (!activeStreams.has(room_id)) {
        activeStreams.set(room_id, new Set());
      }
      
      activeStreams.get(room_id).add(call);
      
      // Handle stream closed
      call.on('cancelled', () => {
        if (activeStreams.has(room_id)) {
          activeStreams.get(room_id).delete(call);
          
          // Clean up empty room streams
          if (activeStreams.get(room_id).size === 0) {
            activeStreams.delete(room_id);
          }
        }
      });
      
      call.on('end', () => {
        if (activeStreams.has(room_id)) {
          activeStreams.get(room_id).delete(call);
          
          // Clean up empty room streams
          if (activeStreams.get(room_id).size === 0) {
            activeStreams.delete(room_id);
          }
        }
      });
      
      // Send initial connection success message
      call.write({
        event_type: 'connected',
        room_id,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('Message stream error:', error);
      call.write({
        event_type: 'error',
        message: { text: 'Server error' },
        timestamp: Date.now()
      });
      call.end();
    }
  }
};

// Add eventListeners to chatServiceImpl for SSE integration
chatServiceImpl.eventListeners = eventListeners;

// Utility function to broadcast to all streams in a room
chatServiceImpl.broadcastToRoom = (roomId, data) => {
  if (activeStreams.has(roomId)) {
    const streams = activeStreams.get(roomId);
    
    for (const stream of streams) {
      try {
        stream.write(data);
      } catch (error) {
        console.error('Error broadcasting to stream:', error);
      }
    }
  }
};

// Add a reference to the broadcastEvent function
chatServiceImpl.broadcastEvent = broadcastEvent;

// Start the gRPC server
const startGrpcServer = (port = 50051) => {
  const server = new grpc.Server();
  server.addService(chatProto.ChatService.service, chatServiceImpl);
  
  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (error, port) => {
      if (error) {
        console.error('Failed to start gRPC server:', error);
        return;
      }
      
      console.log(`gRPC Server running at http://0.0.0.0:${port}`);
      server.start();
    }
  );
  
  return server;
};

module.exports = {
  startGrpcServer,
  chatServiceImpl
};