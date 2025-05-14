const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Room = require('../models/Room');
const Message = require('../models/Message');

// Auth middleware
const auth = (req, res, next) => {
  try {
    const token = req.header('Authorization').replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ success: false, message: 'Authentication required' });
  }
};

// Get all available rooms
router.get('/rooms', auth, async (req, res) => {
  try {
    const rooms = await Room.find()
      .populate('createdBy', 'username')
      .select('name description createdAt activeConnections maxConnections');

    const formattedRooms = rooms.map(room => ({
      id: room._id,
      name: room.name,
      description: room.description,
      createdBy: room.createdBy.username,
      createdAt: room.createdAt,
      activeConnections: room.activeConnections.length,
      maxConnections: room.maxConnections,
      isFull: room.activeConnections.length >= room.maxConnections
    }));

    res.json({ success: true, rooms: formattedRooms });
  } catch (error) {
    console.error('Error fetching rooms:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Create a new room
router.post('/rooms', auth, async (req, res) => {
  try {
    const { name, description, maxConnections } = req.body;

    // Check if room name already exists
    const existingRoom = await Room.findOne({ name });
    if (existingRoom) {
      return res.status(400).json({
        success: false,
        message: 'Room with this name already exists'
      });
    }

    // Create new room
    const room = new Room({
      name,
      description,
      createdBy: req.user.id,
      maxConnections: maxConnections || process.env.MAX_CONNECTIONS_PER_ROOM
    });

    await room.save();

    res.status(201).json({
      success: true,
      room: {
        id: room._id,
        name: room.name,
        description: room.description,
        maxConnections: room.maxConnections
      }
    });
  } catch (error) {
    console.error('Error creating room:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get messages by room ID
router.get('/rooms/:roomId/messages', auth, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { limit = 50, skip = 0 } = req.query;

    // Check if room exists
    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({
        success: false,
        message: 'Room not found'
      });
    }

    // Get messages for the room
    const messages = await Message.findByRoom(roomId, parseInt(limit), parseInt(skip));

    res.json({
      success: true,
      messages: messages
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;