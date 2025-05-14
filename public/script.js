// State management
const state = {
  authToken: null,
  user: null,
  currentRoom: null,
  activeRooms: [],
  socket: null,
  messages: {},
  usingGrpc: false,
  grpcClient: null,
  activeStream: null,
  heartbeatInterval: null,
  testResults: {
    websocket: { latency: 0, throughput: 0 },
    grpc: { latency: 0, throughput: 0 }
  }
};

// DOM Elements
const elements = {
  // Auth
  authContainer: document.getElementById('auth-container'),
  chatContainer: document.getElementById('chat-container'),
  username: document.getElementById('username'),
  password: document.getElementById('password'),
  loginBtn: document.getElementById('login-btn'),
  registerBtn: document.getElementById('register-btn'),
  
  // Status
  connectionStatus: document.getElementById('connection-status'),
  statusIndicator: document.querySelector('.status-indicator'),
  statusText: document.querySelector('.status-text'),
  
  // Rooms
  roomsList: document.getElementById('rooms-list'),
  createRoomBtn: document.getElementById('create-room-btn'),
  modal: document.getElementById('create-room-modal'),
  closeModal: document.querySelector('.modal-content .close'),
  createRoomForm: document.getElementById('create-room-form'),
  roomName: document.getElementById('room-name'),
  roomUsersCount: document.getElementById('room-users-count'),
  
  // Chat
  messageContainer: document.getElementById('message-container'),
  messageForm: document.getElementById('message-form'),
  messageInput: document.getElementById('message-input'),
  sendBtn: document.getElementById('send-btn'),
  
  // Protocol Switch
  protocolSwitch: document.getElementById('protocol-switch'),
  protocolType: document.getElementById('protocol-type'),
  
  // Performance
  testSize: document.getElementById('test-size'),
  testWebSocket: document.getElementById('test-websocket'),
  testGrpc: document.getElementById('test-grpc'),
  wsLatency: document.getElementById('ws-latency'),
  wsThoughput: document.getElementById('ws-throughput'),
  grpcLatency: document.getElementById('grpc-latency'),
  grpcThoughput: document.getElementById('grpc-throughput'),
  performanceChart: document.getElementById('performance-chart')
};

// API endpoints
const API = {
  base: window.location.origin,
  auth: '/api/auth',
  chat: '/api/chat',
  grpc: ':50051', // gRPC server endpoint
};

// Initialize Chart.js performance comparison
let performanceChart = null;

// Initialize the application
function init() {
  // Check for stored token
  const storedToken = localStorage.getItem('authToken');
  const storedUser = localStorage.getItem('user');
  
  if (storedToken && storedUser) {
    state.authToken = storedToken;
    state.user = JSON.parse(storedUser);
    showChat();
    initializeSocket();
    fetchRooms();
  }
  
  // Event listeners
  setupEventListeners();
  
  // Initialize performance chart
  initPerformanceChart();
}

// Setup all event listeners
function setupEventListeners() {
  // Auth
  elements.loginBtn.addEventListener('click', login);
  elements.registerBtn.addEventListener('click', register);
  
  // Room management
  elements.createRoomBtn.addEventListener('click', showCreateRoomModal);
  elements.closeModal.addEventListener('click', hideCreateRoomModal);
  elements.createRoomForm.addEventListener('submit', createRoom);
  
  // Chat
  elements.messageForm.addEventListener('submit', sendMessage);
  
  // Protocol switch
  elements.protocolSwitch.addEventListener('change', toggleProtocol);
  
  // Performance tests
  elements.testWebSocket.addEventListener('click', testWebSocketPerformance);
  elements.testGrpc.addEventListener('click', testGrpcPerformance);
  
  // Close modal on click outside
  window.addEventListener('click', (e) => {
    if (e.target === elements.modal) {
      hideCreateRoomModal();
    }
  });
}

// Authentication functions
async function login() {
  try {
    const username = elements.username.value.trim();
    const password = elements.password.value;
    
    if (!username || !password) {
      showNotification('Please enter both username and password', 'error');
      return;
    }
    
    const response = await fetch(`${API.base}${API.auth}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username, password })
    });
    
    const data = await response.json();
    
    if (data.success) {
      state.authToken = data.token;
      state.user = data.user;
      
      // Save to localStorage
      localStorage.setItem('authToken', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      
      showChat();
      initializeSocket();
      fetchRooms();
    } else {
      showNotification(data.message || 'Login failed', 'error');
    }
  } catch (error) {
    console.error('Login error:', error);
    showNotification('Error connecting to server', 'error');
  }
}

async function register() {
  try {
    const username = elements.username.value.trim();
    const password = elements.password.value;
    
    if (!username || !password) {
      showNotification('Please enter both username and password', 'error');
      return;
    }
    
    const response = await fetch(`${API.base}${API.auth}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username, password })
    });
    
    const data = await response.json();
    
    if (data.success) {
      state.authToken = data.token;
      state.user = data.user;
      
      // Save to localStorage
      localStorage.setItem('authToken', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      
      showChat();
      initializeSocket();
      fetchRooms();
    } else {
      showNotification(data.message || 'Registration failed', 'error');
    }
  } catch (error) {
    console.error('Registration error:', error);
    showNotification('Error connecting to server', 'error');
  }
}

function logout() {
  // Clear state
  state.authToken = null;
  state.user = null;
  state.currentRoom = null;
  
  // Disconnect socket
  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }
  
  // Clear heartbeat interval
  if (state.heartbeatInterval) {
    clearInterval(state.heartbeatInterval);
    state.heartbeatInterval = null;
  }
  
  // Clear local storage
  localStorage.removeItem('authToken');
  localStorage.removeItem('user');
  
  // Show login screen
  showLogin();
}

// WebSocket initialization
function initializeSocket() {
  if (state.usingGrpc) {
    // Using gRPC - don't initialize WebSocket
    updateConnectionStatus(false);
    return;
  }
  
  // Disconnect existing socket if any
  if (state.socket) {
    state.socket.disconnect();
  }
  
  // Create new socket connection with auth token
  state.socket = io(API.base, {
    auth: {
      token: state.authToken
    }
  });
  
  // Socket events
  state.socket.on('connect', () => {
    console.log('Connected to WebSocket');
    updateConnectionStatus(true);
    
    // Setup heartbeat
    setupHeartbeat();
  });
  
  state.socket.on('disconnect', () => {
    console.log('Disconnected from WebSocket');
    updateConnectionStatus(false);
    
    // Clear heartbeat interval
    if (state.heartbeatInterval) {
      clearInterval(state.heartbeatInterval);
      state.heartbeatInterval = null;
    }
  });
  
  state.socket.on('error', (error) => {
    console.error('Socket error:', error);
    showNotification(error.message || 'Connection error', 'error');
  });
  
  // Chat events
  state.socket.on('user:joined', handleUserJoined);
  state.socket.on('user:left', handleUserLeft);
  state.socket.on('message:new', handleNewMessage);
  state.socket.on('heartbeat:ping', handleHeartbeatPing);
  state.socket.on('speed:result', handleSpeedTestResult);
}

// Heartbeat setup for WebSocket connection
function setupHeartbeat() {
  if (state.heartbeatInterval) {
    clearInterval(state.heartbeatInterval);
  }
  
  // Send heartbeat every 10 seconds
  state.heartbeatInterval = setInterval(() => {
    if (state.socket && state.currentRoom) {
      state.socket.emit('heartbeat:pong', { roomId: state.currentRoom.id });
    }
  }, 10000); // 10 seconds
}

function handleHeartbeatPing() {
  if (state.socket && state.currentRoom) {
    state.socket.emit('heartbeat:pong', { roomId: state.currentRoom.id });
  }
}

// Room functions
async function fetchRooms() {
  try {
    const response = await fetch(`${API.base}${API.chat}/rooms`, {
      headers: {
        'Authorization': `Bearer ${state.authToken}`
      }
    });
    
    const data = await response.json();
    
    if (data.success) {
      state.activeRooms = data.rooms;
      renderRoomsList();
    } else {
      showNotification(data.message || 'Failed to fetch rooms', 'error');
    }
  } catch (error) {
    console.error('Error fetching rooms:', error);
    showNotification('Error connecting to server', 'error');
  }
}

function renderRoomsList() {
  elements.roomsList.innerHTML = '';
  
  state.activeRooms.forEach(room => {
    const roomElement = document.createElement('div');
    roomElement.className = `room-item ${room.isFull ? 'full' : ''}`;
    if (state.currentRoom && state.currentRoom.id === room.id) {
      roomElement.classList.add('active');
    }
    
    roomElement.innerHTML = `
      <div class="room-name">${room.name}</div>
      <div class="room-info">${room.activeConnections}/${room.maxConnections} users</div>
    `;
    
    roomElement.addEventListener('click', () => {
      if (!room.isFull) {
        joinRoom(room.id);
      } else {
        showNotification('This room is full', 'error');
      }
    });
    
    elements.roomsList.appendChild(roomElement);
  });
}

function showCreateRoomModal() {
  elements.modal.style.display = 'block';
}

function hideCreateRoomModal() {
  elements.modal.style.display = 'none';
}

async function createRoom(e) {
  e.preventDefault();
  
  const roomNameInput = document.getElementById('room-name-input');
  const roomDescription = document.getElementById('room-description');
  const maxConnections = document.getElementById('max-connections');
  
  const name = roomNameInput.value.trim();
  const description = roomDescription.value.trim();
  const maxConnectionsValue = parseInt(maxConnections.value);
  
  if (!name) {
    showNotification('Please enter a room name', 'error');
    return;
  }
  
  try {
    const response = await fetch(`${API.base}${API.chat}/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.authToken}`
      },
      body: JSON.stringify({
        name,
        description,
        maxConnections: maxConnectionsValue
      })
    });
    
    const data = await response.json();
    
    if (data.success) {
      hideCreateRoomModal();
      fetchRooms();
      showNotification('Room created successfully', 'success');
    } else {
      showNotification(data.message || 'Failed to create room', 'error');
    }
  } catch (error) {
    console.error('Error creating room:', error);
    showNotification('Error connecting to server', 'error');
  }
}

// Join/leave room
function joinRoom(roomId) {
  if (state.usingGrpc) {
    joinRoomGrpc(roomId);
  } else {
    joinRoomWebsocket(roomId);
  }
}

function joinRoomWebsocket(roomId) {
  // Leave current room if needed
  if (state.currentRoom) {
    state.socket.emit('room:leave', { roomId: state.currentRoom.id });
  }
  
  // Join new room
  state.socket.emit('room:join', { roomId });
  
  // Listen for room joined event
  state.socket.once('room:joined', (data) => {
    state.currentRoom = {
      id: data.roomId,
      name: data.name
    };
    
    // Update UI
    elements.roomName.textContent = data.name;
    elements.roomUsersCount.textContent = `${data.activeUsers} users`;
    elements.messageInput.disabled = false;
    elements.sendBtn.disabled = false;
    
    // Fetch previous messages
    fetchMessages(roomId);
    
    // Update room list
    renderRoomsList();
  });
}

async function joinRoomGrpc(roomId) {
  if (!state.grpcClient) {
    showNotification('gRPC client not initialized', 'error');
    return;
  }
  
  try {
    // Leave current room if any
    if (state.currentRoom) {
      await leaveRoomGrpc(state.currentRoom.id);
    }
    
    // Close existing stream if any
    if (state.activeStream) {
      state.activeStream.cancel();
      state.activeStream = null;
    }
    
    // Join new room via gRPC
    const response = await fetch(`${API.base}/api/grpc/join-room`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.authToken}`
      },
      body: JSON.stringify({ roomId })
    });
    
    const data = await response.json();
    
    if (data.success) {
      state.currentRoom = {
        id: data.room.id,
        name: data.room.name
      };
      
      // Update UI
      elements.roomName.textContent = data.room.name;
      elements.roomUsersCount.textContent = `${data.room.active_connections} users`;
      elements.messageInput.disabled = false;
      elements.sendBtn.disabled = false;
      
      // Start message stream
      setupGrpcMessageStream(roomId);
      
      // Fetch previous messages
      fetchMessages(roomId);
      
      // Update room list
      renderRoomsList();
    } else {
      showNotification(data.error_message || 'Failed to join room', 'error');
    }
  } catch (error) {
    console.error('Error joining room via gRPC:', error);
    showNotification('Error connecting to server', 'error');
  }
}

async function leaveRoomGrpc(roomId) {
  try {
    await fetch(`${API.base}/api/grpc/leave-room`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.authToken}`
      },
      body: JSON.stringify({ roomId })
    });
    
    // Close message stream
    if (state.activeStream) {
      state.activeStream.cancel();
      state.activeStream = null;
    }
  } catch (error) {
    console.error('Error leaving room via gRPC:', error);
  }
}

// Setup gRPC message stream
function setupGrpcMessageStream(roomId) {
  // This would be implemented using a server-side proxy in a real app
  // For now, we'll use server-sent events as a fallback
  const evtSource = new EventSource(`${API.base}/api/grpc/stream?roomId=${roomId}&token=${state.authToken}`);
  
  evtSource.onmessage = function(event) {
    const data = JSON.parse(event.data);
    handleGrpcStreamEvent(data);
  };
  
  evtSource.onerror = function() {
    evtSource.close();
  };
  
  // Store reference to close later
  state.activeStream = {
    cancel: () => evtSource.close()
  };
}

function handleGrpcStreamEvent(data) {
  switch (data.event_type) {
    case 'new_message':
      handleNewMessage(data.message);
      break;
    case 'user_joined':
      handleUserJoined(data.user);
      break;
    case 'user_left':
      handleUserLeft(data.user);
      break;
    case 'error':
      showNotification(data.message.text, 'error');
      break;
  }
}

// WebSocket event handlers
function handleUserJoined(data) {
  // Update users count if in the same room
  if (state.currentRoom && state.currentRoom.id === data.roomId) {
    const count = parseInt(elements.roomUsersCount.textContent) + 1;
    elements.roomUsersCount.textContent = `${count} users`;
  }
}

function handleUserLeft(data) {
  // Update users count if in the same room
  if (state.currentRoom && state.currentRoom.id === data.roomId) {
    const count = parseInt(elements.roomUsersCount.textContent) - 1;
    elements.roomUsersCount.textContent = `${count > 0 ? count : 0} users`;
  }
}

function handleNewMessage(message) {
  // Add message to state
  if (!state.messages[message.roomId]) {
    state.messages[message.roomId] = [];
  }
  state.messages[message.roomId].push(message);
  
  // Render if in current room
  if (state.currentRoom && state.currentRoom.id === message.roomId) {
    renderMessage(message);
    
    // Scroll to bottom
    elements.messageContainer.scrollTop = elements.messageContainer.scrollHeight;
  }
}

// Message functions
async function fetchMessages(roomId) {
  try {
    const response = await fetch(`${API.base}${API.chat}/rooms/${roomId}/messages`, {
      headers: {
        'Authorization': `Bearer ${state.authToken}`
      }
    });
    
    const data = await response.json();
    
    if (data.success) {
      // Clear messages container
      elements.messageContainer.innerHTML = '';
      
      // Save to state
      state.messages[roomId] = data.messages;
      
      // Render messages
      data.messages.forEach(message => renderMessage(message));
      
      // Scroll to bottom
      elements.messageContainer.scrollTop = elements.messageContainer.scrollHeight;
    } else {
      showNotification(data.message || 'Failed to fetch messages', 'error');
    }
  } catch (error) {
    console.error('Error fetching messages:', error);
    showNotification('Error connecting to server', 'error');
  }
}

function renderMessage(message) {
  const messageElement = document.createElement('div');
  
  // Format timestamp
  const timestamp = new Date(message.createdAt).toLocaleTimeString();
  
  // Determine message type
  if (message.type === 'system') {
    messageElement.className = 'message-system';
    messageElement.textContent = message.text;
  } else if (message.type === 'announcement') {
    messageElement.className = 'message-announcement';
    messageElement.textContent = message.text;
  } else {
    const isSelf = message.userId === state.user.id;
    messageElement.className = `message ${isSelf ? 'message-self' : 'message-user'}`;
    
    messageElement.innerHTML = `
      <div class="message-header">
        <span class="message-username">${message.username || 'Unknown'}</span>
        <span class="message-time">${timestamp}</span>
      </div>
      <div class="message-text">${message.text}</div>
    `;
  }
  
  elements.messageContainer.appendChild(messageElement);
}

function sendMessage(e) {
  e.preventDefault();
  
  const text = elements.messageInput.value.trim();
  if (!text || !state.currentRoom) return;
  
  if (state.usingGrpc) {
    sendMessageGrpc(text);
  } else {
    sendMessageWebsocket(text);
  }
  
  // Clear input
  elements.messageInput.value = '';
}

function sendMessageWebsocket(text) {
  state.socket.emit('message:send', {
    roomId: state.currentRoom.id,
    text
  });
}

async function sendMessageGrpc(text) {
  try {
    await fetch(`${API.base}/api/grpc/send-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.authToken}`
      },
      body: JSON.stringify({
        roomId: state.currentRoom.id,
        text
      })
    });
  } catch (error) {
    console.error('Error sending message via gRPC:', error);
    showNotification('Failed to send message', 'error');
  }
}

// Toggle between WebSocket and gRPC
function toggleProtocol() {
  const usingGrpc = elements.protocolSwitch.checked;
  
  if (usingGrpc === state.usingGrpc) return;
  
  state.usingGrpc = usingGrpc;
  elements.protocolType.textContent = usingGrpc ? 'gRPC' : 'WebSocket';
  
  // Handle protocol switch
  if (usingGrpc) {
    // Switch to gRPC
    if (state.socket) {
      state.socket.disconnect();
    }
    updateConnectionStatus(false);
    
    // Join current room with gRPC if applicable
    if (state.currentRoom) {
      joinRoomGrpc(state.currentRoom.id);
    }
  } else {
    // Switch to WebSocket
    if (state.activeStream) {
      state.activeStream.cancel();
      state.activeStream = null;
    }
    
    // Initialize WebSocket
    initializeSocket();
    
    // Join current room with WebSocket if applicable
    if (state.currentRoom) {
      joinRoomWebsocket(state.currentRoom.id);
    }
  }
}

// Performance testing
function generateTestPayload(size) {
  let payload = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  
  let byteSize;
  switch (size) {
    case 'small':
      byteSize = 1024; // 1KB
      break;
    case 'medium':
      byteSize = 10 * 1024; // 10KB
      break;
    case 'large':
      byteSize = 100 * 1024; // 100KB
      break;
    default:
      byteSize = 1024;
  }
  
  // Generate random string
  for (let i = 0; i < byteSize; i++) {
    payload += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return payload;
}

function testWebSocketPerformance() {
  if (!state.socket || !state.socket.connected) {
    showNotification('WebSocket not connected', 'error');
    return;
  }
  
  const size = elements.testSize.value;
  const payload = generateTestPayload(size);
  
  // Send test payload
  const startTime = Date.now();
  state.socket.emit('speed:test', {
    timestamp: startTime,
    payload
  });
}

async function testGrpcPerformance() {
  if (!(state.authToken)) {
    showNotification('Not authenticated', 'error');
    return;
  }
  
  const size = elements.testSize.value;
  const payload = generateTestPayload(size);
  
  try {
    const startTime = Date.now();
    
    const response = await fetch(`${API.base}/api/grpc/speed-test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.authToken}`
      },
      body: JSON.stringify({
        timestamp: startTime,
        payload
      })
    });
    
    const data = await response.json();
    
    if (data.success) {
      const endTime = Date.now();
      const latency = data.latency;
      const payloadSize = data.payload_size;
      const roundTripTime = endTime - startTime;
      const throughput = Math.round((payloadSize / 1024) / (roundTripTime / 1000));
      
      // Update state
      state.testResults.grpc = {
        latency,
        throughput
      };
      
      // Update UI
      elements.grpcLatency.textContent = `${latency}`;
      elements.grpcThoughput.textContent = `${throughput}`;
      
      // Update chart
      updatePerformanceChart();
    } else {
      showNotification('gRPC test failed', 'error');
    }
  } catch (error) {
    console.error('gRPC test error:', error);
    showNotification('Error testing gRPC performance', 'error');
  }
}

function handleSpeedTestResult(data) {
  const endTime = Date.now();
  const roundTripTime = endTime - data.sentTimestamp;
  const latency = data.latency;
  const payloadSize = data.payloadSize;
  const throughput = Math.round((payloadSize / 1024) / (roundTripTime / 1000));
  
  // Update state
  state.testResults.websocket = {
    latency,
    throughput
  };
  
  // Update UI
  elements.wsLatency.textContent = `${latency}`;
  elements.wsThoughput.textContent = `${throughput}`;
  
  // Update chart
  updatePerformanceChart();
}

function initPerformanceChart() {
  const ctx = elements.performanceChart.getContext('2d');
  performanceChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Latency (ms)', 'Throughput (KB/s)'],
      datasets: [
        {
          label: 'WebSocket',
          data: [0, 0],
          backgroundColor: 'rgba(74, 111, 165, 0.7)',
          borderColor: 'rgba(74, 111, 165, 1)',
          borderWidth: 1
        },
        {
          label: 'gRPC',
          data: [0, 0],
          backgroundColor: 'rgba(92, 184, 92, 0.7)',
          borderColor: 'rgba(92, 184, 92, 1)',
          borderWidth: 1
        }
      ]
    },
    options: {
      responsive: true,
      scales: {
        y: {
          beginAtZero: true
        }
      }
    }
  });
}

function updatePerformanceChart() {
  performanceChart.data.datasets[0].data = [
    state.testResults.websocket.latency,
    state.testResults.websocket.throughput
  ];
  
  performanceChart.data.datasets[1].data = [
    state.testResults.grpc.latency,
    state.testResults.grpc.throughput
  ];
  
  performanceChart.update();
}

// UI functions
function showChat() {
  elements.authContainer.classList.add('hidden');
  elements.chatContainer.classList.remove('hidden');
}

function showLogin() {
  elements.authContainer.classList.remove('hidden');
  elements.chatContainer.classList.add('hidden');
}

function updateConnectionStatus(connected) {
  if (connected) {
    elements.statusIndicator.classList.remove('offline');
    elements.statusIndicator.classList.add('online');
    elements.statusText.textContent = 'Connected';
  } else {
    elements.statusIndicator.classList.remove('online');
    elements.statusIndicator.classList.add('offline');
    elements.statusText.textContent = 'Disconnected';
  }
}

function showNotification(message, type) {
  // Create notification element
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;
  
  // Add to document
  document.body.appendChild(notification);
  
  // Remove after 3 seconds
  setTimeout(() => {
    notification.remove();
  }, 3000);
}

// Initialize application
document.addEventListener('DOMContentLoaded', init);