const Room = require('../models/Room');
const mongoose = require('mongoose');

// Setup heartbeat interval (in milliseconds)
const HEARTBEAT_INTERVAL = process.env.HEARTBEAT_INTERVAL || 10000;
const HEARTBEAT_TIMEOUT = HEARTBEAT_INTERVAL * 2; // Double the interval for timeout

/**
 * Initialize heartbeat monitoring for a socket and room
 * @param {Object} socket - Socket.io socket object
 * @param {String} roomId - MongoDB room ID
 */
const initializeHeartbeat = (socket, io) => {
  // Send ping to client every HEARTBEAT_INTERVAL
  const intervalId = setInterval(() => {
    socket.emit('heartbeat:ping');
  }, HEARTBEAT_INTERVAL);
  
  // Listen for pong from client
  socket.on('heartbeat:pong', async (data) => {
    try {
      if (data.roomId && mongoose.connection.readyState === 1) { // Check if MongoDB is connected (1 = connected)
        const room = await Room.findById(data.roomId);
        if (room) {
          await room.updateHeartbeat(socket.id);
        }
      }
    } catch (error) {
      console.error('Heartbeat update error:', error);
    }
  });
  
  // Clean up on disconnect
  socket.on('disconnect', () => {
    clearInterval(intervalId);
  });
  
  return intervalId;
};

/**
 * Check for inactive connections and disconnect them
 * @param {Object} io - Socket.io instance
 */
const monitorInactiveConnections = async (io) => {
  // Skip monitoring if MongoDB is not connected
  if (mongoose.connection.readyState !== 1) {
    console.log('Skipping inactive connection monitoring: MongoDB not connected');
    return;
  }

  try {
    const cutoffTime = new Date(Date.now() - HEARTBEAT_TIMEOUT);
    const rooms = await Room.find();
    
    for (const room of rooms) {
      const inactiveConnections = room.activeConnections.filter(
        conn => conn.lastHeartbeat < cutoffTime
      );
      
      for (const conn of inactiveConnections) {
        // Disconnect the socket
        const socket = io.sockets.sockets.get(conn.socketId);
        if (socket) {
          socket.disconnect(true);
        }
        
        // Remove from room's activeConnections
        room.activeConnections = room.activeConnections.filter(
          c => c.socketId !== conn.socketId
        );
      }
      
      if (inactiveConnections.length > 0) {
        await room.save();
      }
    }
  } catch (error) {
    console.error('Monitor inactive connections error:', error);
  }
};

/**
 * Setup automatic monitoring of inactive connections
 * @param {Object} io - Socket.io instance
 */
const setupInactiveConnectionsMonitor = (io) => {
  // Check for inactive connections every HEARTBEAT_INTERVAL
  return setInterval(() => {
    monitorInactiveConnections(io);
  }, HEARTBEAT_INTERVAL);
};

module.exports = {
  initializeHeartbeat,
  setupInactiveConnectionsMonitor
};