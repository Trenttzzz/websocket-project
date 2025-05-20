// State management
const state = {
  authToken: null,
  user: null,
  currentRoom: null,
  activeRooms: [],
  socket: null,
  messages: {},
  heartbeatInterval: null,
  joinRoomTimeoutId: null, // ID untuk timeout proses join room
  selectedRoom: null // Menambahkan state untuk room yang dipilih (belum tentu joined)
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
  joinRoomBtn: document.getElementById('join-room-btn'),
  leaveRoomBtn: document.getElementById('leave-room-btn'),
  
  // Chat
  messageContainer: document.getElementById('message-container'),
  messageForm: document.getElementById('message-form'),
  messageInput: document.getElementById('message-input'),
  sendBtn: document.getElementById('send-btn')
};

// API endpoints
const API = {
  base: window.location.origin,
  auth: '/api/auth',
  chat: '/api/chat'
};

// Initialize the application
function init() {
  // Check for stored token
  const storedToken = localStorage.getItem('authToken');
  const storedUser = localStorage.getItem('user');
  const storedRoom = localStorage.getItem('currentRoom');
  
  if (storedToken && storedUser) {
    state.authToken = storedToken;
    state.user = JSON.parse(storedUser);
    
    // Restore current room if available
    if (storedRoom) {
      state.currentRoom = JSON.parse(storedRoom);
    }
    
    showChat();
    initializeSocket();
    fetchRooms();
    
    // Rejoin current room if was in one before refresh
    if (state.currentRoom) {
      setTimeout(() => {
        joinRoom(state.currentRoom.id);
      }, 1000); // Delay to ensure socket connection is established
    }
  }
  
  // Event listeners
  setupEventListeners();
}

// Setup all event listeners
function setupEventListeners() {
  // Auth
  elements.loginBtn.addEventListener('click', login);
  elements.registerBtn.addEventListener('click', register);
  elements.logoutBtn = document.getElementById('logout-btn');
  elements.logoutBtn.addEventListener('click', logout);
  
  // Room management
  elements.createRoomBtn.addEventListener('click', showCreateRoomModal);
  elements.closeModal.addEventListener('click', hideCreateRoomModal);
  elements.createRoomForm.addEventListener('submit', createRoom);
  elements.joinRoomBtn.addEventListener('click', handleJoinRoomBtnClick);
  elements.leaveRoomBtn.addEventListener('click', handleLeaveRoomBtnClick);
  
  // Chat
  elements.messageForm.addEventListener('submit', sendMessage);
  
  // Close modal on click outside, but not when clicking modal content
  window.addEventListener('click', (e) => {
    if (e.target === elements.modal) {
      hideCreateRoomModal();
    }
  });
  
  // Prevent modal closing when clicking inside modal content
  document.querySelector('.modal-content').addEventListener('click', (e) => {
    e.stopPropagation();
  });
  
  // Tab visibility handler
  document.addEventListener('visibilitychange', handleVisibilityChange);
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
  localStorage.removeItem('currentRoom');
  
  // Show login screen
  showLogin();
}

// WebSocket initialization
function initializeSocket() {
  // Disconnect existing socket if any
  if (state.socket) {
    state.socket.disconnect();
  }
  
  // Force secure transport using WSS
  state.socket = io(API.base, {
    auth: {
      token: state.authToken
    },
    secure: true,
    transports: ['websocket'],
    rejectUnauthorized: false // Untuk development dengan self-signed certificates
  });
  
  // Socket events
  state.socket.on('connect', () => {
    console.log('Connected to WebSocket Secure (WSS)');
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
  state.socket.on('room:deleted', handleRoomDeleted);
  state.socket.on('heartbeat:ping', handleHeartbeatPing);
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
    
    // Tanda room yang sudah joined vs selected
    if (state.currentRoom && state.currentRoom.id === room.id) {
      roomElement.classList.add('active');
    } else if (state.selectedRoom && state.selectedRoom.id === room.id) {
      roomElement.classList.add('selected');
    }
    
    // Check if current user is the creator of the room
    const isCreator = room.createdBy === state.user.username;
    
    roomElement.innerHTML = `
      <div class="room-item-content">
        <div class="room-name">${room.name}</div>
        <div class="room-info">${room.activeConnections}/${room.maxConnections} users</div>
        ${isCreator ? '<button class="delete-room-btn" title="Delete Room"><i class="fas fa-trash"></i>Delete</button>' : ''}
      </div>
    `;
    
    roomElement.querySelector('.room-item-content').addEventListener('click', (e) => {
      // Don't select if clicking on delete button
      if (e.target.closest('.delete-room-btn')) {
        e.stopPropagation();
        return;
      }
      
      if (room.isFull && (!state.currentRoom || state.currentRoom.id !== room.id)) {
        showNotification('This room is full', 'error');
        return;
      }
      
      // Pilih room (tidak otomatis join)
      selectRoom(room);
    });
    
    // Add event listener for delete button if present
    const deleteBtn = roomElement.querySelector('.delete-room-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteRoom(room.id);
      });
    }
    
    elements.roomsList.appendChild(roomElement);
  });
  
  // Perbarui status tombol
  updateRoomButtonsState();
}

function showCreateRoomModal() {
  elements.modal.style.display = 'block';
  
  // Reset form fields
  const roomNameInput = document.getElementById('room-name-input');
  const roomDescription = document.getElementById('room-description');
  const maxConnections = document.getElementById('max-connections');
  
  roomNameInput.value = '';
  roomDescription.value = '';
  maxConnections.value = '10';
  
  // Set focus on room name input after a short delay to ensure the modal is visible
  setTimeout(() => {
    roomNameInput.focus();
  }, 100);
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
  // Hapus timeout sebelumnya jika ada
  if (state.joinRoomTimeoutId) {
    clearTimeout(state.joinRoomTimeoutId);
    state.joinRoomTimeoutId = null;
  }

  // Leave current room if needed
  if (state.currentRoom && state.currentRoom.id !== roomId) {
    state.socket.emit('room:leave', { roomId: state.currentRoom.id });
    // Reset current room state immediately for responsiveness
    state.currentRoom = null;
    elements.messageContainer.innerHTML = ''; // Kosongkan pesan dari room sebelumnya
    elements.messageInput.disabled = true;
    elements.sendBtn.disabled = true;
    elements.roomName.textContent = 'Joining room...';
    elements.roomUsersCount.textContent = '0 users';
  } else if (state.currentRoom && state.currentRoom.id === roomId) {
    // Jika sudah di room yang sama, tidak perlu join lagi
    // Cukup pastikan input aktif
    elements.messageInput.removeAttribute('disabled');
    elements.sendBtn.removeAttribute('disabled');
    elements.messageInput.focus();
    return;
  }
  
  // Join new room
  state.socket.emit('room:join', { roomId });
  
  // Set timeout untuk penanganan jika event 'room:joined' tidak diterima
  state.joinRoomTimeoutId = setTimeout(() => {
    showNotification('Failed to join room. Please try again.', 'error');
    // Reset UI jika join gagal
    elements.roomName.textContent = 'Select a Room';
    elements.messageInput.disabled = true;
    elements.sendBtn.disabled = true;
    state.joinRoomTimeoutId = null;
  }, 5000); // Timeout 5 detik

  // Listen for room joined event
  state.socket.once('room:joined', (data) => {
    // Hapus timeout karena event sudah diterima
    if (state.joinRoomTimeoutId) {
      clearTimeout(state.joinRoomTimeoutId);
      state.joinRoomTimeoutId = null;
    }

    // Pastikan event ini untuk room yang benar-benar ingin kita masuki
    if (data.roomId !== roomId) {
      console.warn('Received room:joined event for a different room.', { expected: roomId, received: data.roomId });
      return; // Abaikan jika bukan untuk room yang dituju
    }

    state.currentRoom = {
      id: data.roomId,
      name: data.name
    };
    
    // Save current room to localStorage
    localStorage.setItem('currentRoom', JSON.stringify(state.currentRoom));
    
    // Update UI
    elements.roomName.textContent = data.name;
    elements.roomUsersCount.textContent = `${data.activeUsers} users`;
    
    // Explicitly enable message input and send button
    elements.messageInput.removeAttribute('disabled');
    elements.sendBtn.removeAttribute('disabled');
    
    // Ensure the elements are focused and ready for typing
    setTimeout(() => {
      elements.messageInput.focus();
    }, 100);
    
    // Fetch previous messages
    fetchMessages(roomId);
    
    // Update room list
    renderRoomsList();
  });
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
    
    // Autoscroll dihapus untuk membuat scroll manual
  }
}

// Handle room deleted event
function handleRoomDeleted(data) {
  if (state.currentRoom && state.currentRoom.id === data.roomId) {
    state.currentRoom = null;
    localStorage.removeItem('currentRoom');
    elements.roomName.textContent = 'Select a Room';
    elements.roomUsersCount.textContent = '0 users';
    elements.messageContainer.innerHTML = '';
    elements.messageInput.disabled = true;
    elements.sendBtn.disabled = true;
    
    showNotification(data.message, 'info');
  }
  
  // Refresh the rooms list
  fetchRooms();
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
  
  // Removed auto-scroll to enable manual scrolling
}

function sendMessage(e) {
  e.preventDefault();
  
  const text = elements.messageInput.value.trim();
  if (!text || !state.currentRoom) return;
  
  state.socket.emit('message:send', {
    roomId: state.currentRoom.id,
    text
  });
  
  // Ensure inputs remain enabled
  elements.messageInput.removeAttribute('disabled');
  elements.sendBtn.removeAttribute('disabled');
  
  // Clear input
  elements.messageInput.value = '';
  
  // Re-focus the input field
  elements.messageInput.focus();
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

// Handle room deletion
async function deleteRoom(roomId) {
  if (!confirm('Are you sure you want to delete this room? This action cannot be undone.')) {
    return;
  }
  
  try {
    const response = await fetch(`${API.base}${API.chat}/rooms/${roomId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${state.authToken}`
      }
    });
    
    const data = await response.json();
    
    if (data.success) {
      // If we're in the deleted room, reset the UI
      if (state.currentRoom && state.currentRoom.id === roomId) {
        state.currentRoom = null;
        localStorage.removeItem('currentRoom');
        elements.roomName.textContent = 'Select a Room';
        elements.roomUsersCount.textContent = '0 users';
        elements.messageContainer.innerHTML = '';
        elements.messageInput.disabled = true;
        elements.sendBtn.disabled = true;
      }
      
      // Refresh the rooms list
      fetchRooms();
      showNotification('Room deleted successfully', 'success');
    } else {
      showNotification(data.message || 'Failed to delete room', 'error');
    }
  } catch (error) {
    console.error('Error deleting room:', error);
    showNotification('Error connecting to server', 'error');
  }
}

// Handle visibility change
function handleVisibilityChange() {
  if (document.visibilityState === 'visible') {
    console.log('Tab is now visible, checking connection...');
    
    if (state.socket && !state.socket.connected) {
      console.log('Socket disconnected while tab was hidden, reconnecting...');
      initializeSocket();
      
      // Reconnect to current room if we have one
      if (state.currentRoom) {
        setTimeout(() => {
          console.log('Rejoining room:', state.currentRoom.id);
          joinRoom(state.currentRoom.id);
        }, 1000);
      }
    }
  }
}

// Fungsi untuk menangani klik tombol Join Room
function handleJoinRoomBtnClick() {
  // Memastikan ada room yang dipilih
  const selectedRoom = state.selectedRoom;
  if (!selectedRoom) {
    showNotification('Please select a room first', 'error');
    return;
  }
  
  // Memastikan room tidak penuh
  const room = state.activeRooms.find(room => room.id === selectedRoom.id);
  if (room && room.isFull) {
    showNotification('This room is full', 'error');
    return;
  }
  
  // Join room yang dipilih
  joinRoom(selectedRoom.id);
}

// Fungsi untuk menangani klik tombol Leave Room
function handleLeaveRoomBtnClick() {
  // Memastikan kita berada dalam room
  if (!state.currentRoom) {
    showNotification('You are not in any room', 'error');
    return;
  }
  
  // Keluar dari room saat ini
  leaveRoom(state.currentRoom.id);
}

// Fungsi untuk keluar dari room
function leaveRoom(roomId) {
  if (!state.currentRoom || state.currentRoom.id !== roomId) {
    return;
  }
  
  state.socket.emit('room:leave', { roomId });
  
  // Reset state dan UI
  state.currentRoom = null;
  localStorage.removeItem('currentRoom');
  
  // Update UI
  elements.roomName.textContent = 'Select a Room';
  elements.roomUsersCount.textContent = '0 users';
  elements.messageContainer.innerHTML = '';
  elements.messageInput.disabled = true;
  elements.sendBtn.disabled = true;
  
  // Update button states
  updateRoomButtonsState();
  
  showNotification('You have left the room', 'info');
  
  // Update room list to show the correct active status
  renderRoomsList();
}

// Fungsi untuk memperbarui status tombol-tombol room
function updateRoomButtonsState() {
  // Join button aktif jika ada room dipilih dan kita belum join
  if (state.selectedRoom && (!state.currentRoom || state.currentRoom.id !== state.selectedRoom.id)) {
    elements.joinRoomBtn.removeAttribute('disabled');
    elements.joinRoomBtn.classList.add('active');
  } else {
    elements.joinRoomBtn.setAttribute('disabled', 'disabled');
    elements.joinRoomBtn.classList.remove('active');
  }
  
  // Leave button aktif jika kita sudah join room
  if (state.currentRoom) {
    elements.leaveRoomBtn.removeAttribute('disabled');
    elements.leaveRoomBtn.classList.add('active');
  } else {
    elements.leaveRoomBtn.setAttribute('disabled', 'disabled');
    elements.leaveRoomBtn.classList.remove('active');
  }
}

// Fungsi untuk memilih room (tanpa join)
function selectRoom(room) {
  // Simpan room yang dipilih dalam state
  state.selectedRoom = {
    id: room.id,
    name: room.name
  };
  
  // Update informasi room di header
  elements.roomName.textContent = room.name;
  elements.roomUsersCount.textContent = `${room.activeConnections}/${room.maxConnections} users`;
  
  // Clear pesan jika belum join room ini
  if (!state.currentRoom || state.currentRoom.id !== room.id) {
    elements.messageContainer.innerHTML = '';
    elements.messageContainer.innerHTML = '<div class="message-prompt">Click "Join Room" button to join this room and start chatting</div>';
  }
  
  // Update room list untuk menampilkan room yang dipilih
  renderRoomsList();
  
  // Update status tombol
  updateRoomButtonsState();
}

// Initialize application
document.addEventListener('DOMContentLoaded', init);