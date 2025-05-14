const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

// SSL Certificate options
const getSSLOptions = () => {
  try {
    return {
      key: fs.readFileSync(path.join(__dirname, '../../certificates/server.key')),
      cert: fs.readFileSync(path.join(__dirname, '../../certificates/server.crt'))
    };
  } catch (error) {
    console.error('Error loading SSL certificates:', error);
    return null;
  }
};

// Socket authentication middleware
const socketAuth = (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    
    if (!token) {
      return next(new Error('Authentication required'));
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
      if (err) {
        return next(new Error('Invalid token'));
      }
      
      socket.user = decoded;
      next();
    });
  } catch (error) {
    return next(new Error('Authentication error'));
  }
};

module.exports = {
  getSSLOptions,
  socketAuth
};