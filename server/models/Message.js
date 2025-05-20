const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  roomId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Room',
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    // userId hanya wajib untuk pesan tipe user
    required: function() {
      return this.type === 'user';
    }
  },
  text: {
    type: String,
    required: true,
    trim: true,
    maxlength: 1000
  },
  type: {
    type: String,
    enum: ['user', 'system', 'announcement'],
    default: 'user'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Method to find messages by room with pagination
MessageSchema.statics.findByRoom = function(roomId, limit = 50, skip = 0) {
  return this.find({ roomId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('userId', 'username')
    .sort({ createdAt: 1 });
};

module.exports = mongoose.model('Message', MessageSchema);