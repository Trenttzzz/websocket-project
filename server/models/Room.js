const mongoose = require('mongoose');

const RoomSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 30
  },
  description: {
    type: String,
    maxlength: 200
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  activeConnections: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    socketId: String,
    lastHeartbeat: {
      type: Date,
      default: Date.now
    }
  }],
  maxConnections: {
    type: Number,
    default: 10
  }
});

// Method to check if room has reached connection limit
RoomSchema.methods.hasReachedConnectionLimit = function() {
  return this.activeConnections.length >= this.maxConnections;
};

// Method to add a connection to the room
RoomSchema.methods.addConnection = function(userId, socketId) {
  if (this.hasReachedConnectionLimit()) {
    throw new Error('Room has reached maximum connection limit');
  }
  
  // Check if user already has a connection
  const existingConnection = this.activeConnections.find(
    conn => conn.userId.toString() === userId.toString()
  );
  
  if (existingConnection) {
    existingConnection.socketId = socketId;
    existingConnection.lastHeartbeat = Date.now();
  } else {
    this.activeConnections.push({
      userId,
      socketId,
      lastHeartbeat: Date.now()
    });
  }
  
  return this.save();
};

// Method to update heartbeat for a connection
RoomSchema.methods.updateHeartbeat = function(socketId) {
  const connection = this.activeConnections.find(conn => conn.socketId === socketId);
  if (connection) {
    connection.lastHeartbeat = Date.now();
    return this.save();
  }
  return Promise.resolve(null);
};

// Method to remove a connection from the room
RoomSchema.methods.removeConnection = function(socketId) {
  this.activeConnections = this.activeConnections.filter(
    conn => conn.socketId !== socketId
  );
  return this.save();
};

module.exports = mongoose.model('Room', RoomSchema);