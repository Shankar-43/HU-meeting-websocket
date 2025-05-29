const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();

// Add basic middleware for deployment
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "WebSocket server is running",
    timestamp: new Date().toISOString(),
    port: process.env.PORT || 8080
  });
});

// Additional health check for load balancers
app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy" });
});

const server = http.createServer(app);

// Enhanced Socket.IO configuration for deployment
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  // Important: Configure transports for better compatibility
  transports: ['websocket', 'polling'],
  // Increase timeout values for production
  pingTimeout: 60000,
  pingInterval: 25000,
  // Allow HTTP long-polling fallback
  allowEIO3: true,
  // Configure for reverse proxy environments
  allowUpgrades: true,
  upgradeTimeout: 30000,
  // Additional options for production stability
  maxHttpBufferSize: 1e6,
  serveClient: false
});

// Define sessions object to store session data
const sessions = {};

function handleDoctorPreview(socket) {
  socket.emit("doctor_preview", {
    type: "doctor_preview",
    message: "Doctor is in preview mode.",
  });
  console.log("Doctor is in preview mode:", socket.id);
}

function handleDoctorJoin(socket, data) {
  const sessionId = data.sessionID;

  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      doctor: null,
      patients: {
        waitingLobby: [],
        joinedPatients: [],
      },
    };
  }

  const session = sessions[sessionId];

  // Check if doctor is already assigned to this session
  if (session.doctor && session.doctor.id === socket.id) {
    console.log(`Doctor ${socket.id} is already assigned to session ${sessionId}`);
    socket.emit("doctor_joined", {
      type: "doctor_joined",
      message: "You are already the doctor for this meeting.",
    });
    return;
  }

  // Assign doctor to session
  session.doctor = { id: socket.id, socket };

  socket.emit("doctor_joined", {
    type: "doctor_joined",
    message: "Doctor has joined the meeting.",
    sessionId: sessionId,
    waitingPatients: session.patients.waitingLobby.length,
    joinedPatients: session.patients.joinedPatients.length
  });

  // Notify doctor about all patients in the waiting lobby
  session.patients.waitingLobby.forEach((patient) => {
    socket.emit("patient_request", {
      type: "patient_request",
      patientId: patient.id,
      username: patient.username,
    });
  });

  console.log(`Doctor ${socket.id} joined session ${sessionId}`);
  console.log(`Patients in waiting lobby: ${session.patients.waitingLobby.length}`);
  console.log(`Patients already joined: ${session.patients.joinedPatients.length}`);
}

function handlePatientJoin(socket, data) {
  const sessionId = data.sessionID;
  const patient = { socket, id: socket.id, username: data.userName };

  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      doctor: null,
      patients: {
        waitingLobby: [],
        joinedPatients: [],
      },
    };
  }

  const session = sessions[sessionId];

  // Check if patient is already in waiting lobby or joined patients
  const isAlreadyInWaiting = session.patients.waitingLobby.some(p => p.id === patient.id);
  const isAlreadyJoined = session.patients.joinedPatients.some(p => p.id === patient.id);

  if (isAlreadyInWaiting) {
    console.log(`Patient ${patient.id} is already in waiting lobby`);
    socket.emit("waiting", {
      type: "waiting",
      message: "You are already in the waiting lobby.",
      patientId: patient.id,
    });
    return;
  }

  if (isAlreadyJoined) {
    console.log(`Patient ${patient.id} is already in the meeting`);
    socket.emit("joined_meeting", {
      type: "joined_meeting",
      message: "You are already in the meeting.",
    });
    return;
  }

  // Add patient to waiting lobby
  session.patients.waitingLobby.push(patient);

  socket.emit("waiting", {
    type: "waiting",
    message: "Please wait in the lobby.",
    patientId: patient.id,
  });

  // Notify doctor if present
  if (session.doctor && session.doctor.socket.connected) {
    session.doctor.socket.emit("patient_request", {
      type: "patient_request",
      patientId: patient.id,
      username: patient.username,
    });
    console.log(`Notified doctor about patient request: ${patient.username}`);
  } else {
    console.log("No doctor available to notify about patient request");
  }

  console.log(`Patient ${patient.username} (${patient.id}) added to waitingLobby for session ${sessionId}`);
  console.log(`Current waiting lobby size: ${session.patients.waitingLobby.length}`);
}

function handlePatientApproval(socket, data) {
  const sessionId = data.sessionID;
  const patientId = data.patientID;
  const session = sessions[sessionId];

  console.log(`Doctor ${socket.id} attempting to approve patient ${patientId} in session ${sessionId}`);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    socket.emit("error", { message: "Session not found" });
    return;
  }

  if (!session.doctor || session.doctor.id !== socket.id) {
    console.log(`Unauthorized approval attempt by ${socket.id} for session ${sessionId}`);
    socket.emit("error", { message: "Unauthorized: Only the doctor can approve patients" });
    return;
  }

  const patient = session.patients.waitingLobby.find((client) => client.id === patientId);

  if (!patient) {
    console.log(`Patient ${patientId} not found in waiting lobby`);
    socket.emit("error", { message: "Patient not found in waiting lobby" });
    return;
  }

  // Check if patient socket is still connected
  if (!patient.socket.connected) {
    console.log(`Patient ${patientId} socket is disconnected, removing from lobby`);
    session.patients.waitingLobby = session.patients.waitingLobby.filter((client) => client.id !== patientId);
    return;
  }

  // Approve the patient
  patient.socket.emit("approved", {
    type: "approved",
    message: "You are approved to join the meeting.",
    patientID: patientId,
    sessionID: sessionId
  });

  // Move patient from waiting lobby to joined patients
  session.patients.waitingLobby = session.patients.waitingLobby.filter((client) => client.id !== patientId);
  session.patients.joinedPatients.push(patient);

  // Confirm to doctor
  socket.emit("patient_approved", {
    type: "patient_approved",
    message: `Patient ${patient.username} has been approved`,
    patientId: patientId,
    patientUsername: patient.username
  });

  console.log(`Patient ${patient.username} (${patientId}) approved and moved to joined patients`);
  console.log(`Current waiting lobby: ${session.patients.waitingLobby.length} patients`);
  console.log(`Current joined patients: ${session.patients.joinedPatients.length} patients`);
}

function handlePatientRejection(socket, data) {
  const sessionId = data.sessionID;
  const patientId = data.patientID;
  const session = sessions[sessionId];

  if (session && session.doctor.id === socket.id) {
    const patient = session.patients.waitingLobby.find((client) => client.id === patientId);
    if (patient) {
      patient.socket.emit("rejected", {
        type: "rejected",
        message: "You are not allowed to join the meeting.",
      });

      session.patients.waitingLobby = session.patients.waitingLobby.filter((client) => client.id !== patientId);

      console.log("Patient rejected:", patient);
      console.log("Current waitingLobby:", session.patients.waitingLobby);
    }
  }
}

function handlePatientLeaveMeeting(socket, data) {
  const sessionId = data.patientId;
  const patientId = socket.id;
  const session = sessions[sessionId];

  if (session) {
    const patient = session.patients.joinedPatients.find((p) => p.id === patientId);
    if (patient) {
      session.patients.joinedPatients = session.patients.joinedPatients.filter((p) => p.id !== patientId);

      if (session.doctor) {
        session.doctor.socket.emit("patient_leave", {
          type: "patient_leave",
          message: "Patient left the meeting.",
        });
      }

      socket.emit("leave_confirmation", {
        type: "leave_confirmation",
        message: "You have successfully left the meeting.",
      });

      patient.socket.disconnect();

      console.log("Current joinedPatients after leave:", session.patients.joinedPatients);
    } else {
      console.log("Patient not found in joinedPatients:", patientId);
    }
  }
}

function handlePatientJoinMeeting(socket, data) {
  const sessionId = data.sessionID;
  const session = sessions[sessionId];
  const patientId = socket.id;
  const patient = { socket, id: patientId, username: data.userName };

  if (session) {
    if (session.doctor) {
      session.doctor.socket.emit("patient_joined", {
        type: "patient_joined",
        message: `${patient.username} has joined the meeting.`,
      });
    }

    session.patients.joinedPatients.push(patient);
    session.patients.waitingLobby = session.patients.waitingLobby.filter((p) => p.id !== patientId);

    console.log("session===", session);

    socket.emit("joined_meeting", {
      type: "joined_meeting",
      message: "You have successfully joined the meeting.",
    });

    console.log(`Patient ${patient.id} joined the meeting.`);
    console.log("Current joinedPatients:", session.patients.joinedPatients);
  }
}

function handleDoctorEndMeeting(socket) {
  const sessionId = Object.keys(sessions).find(
    (id) => sessions[id].doctor && sessions[id].doctor.id === socket.id
  );
  const session = sessions[sessionId];

  if (sessionId) {
    const endMessage = {
      type: "doctor_end_meeting",
      message: "The doctor has ended the meeting.",
    };

    session.patients.joinedPatients.forEach((patient) => {
      if (patient.socket.connected) {
        patient.socket.emit("doctor_end_meeting", endMessage);
        patient.socket.disconnect(true);
      }
    });

    session.patients.waitingLobby.forEach((patient) => {
      if (patient.socket.connected) {
        patient.socket.emit("doctor_end_meeting", endMessage);
        patient.socket.disconnect(true);
      }
    });

    session.doctor.socket.emit("doctor_end_meeting", endMessage);
    session.doctor.socket.disconnect(true);
    delete sessions[sessionId];

    console.log("Meeting ended by doctor. All patients disconnected.");
  }
}

// Cleanup function for disconnected clients
function cleanupDisconnectedClient(socketId) {
  Object.keys(sessions).forEach(sessionId => {
    const session = sessions[sessionId];

    // Remove from doctor
    if (session.doctor && session.doctor.id === socketId) {
      session.doctor = null;
    }

    // Remove from waiting lobby
    session.patients.waitingLobby = session.patients.waitingLobby.filter(
      patient => patient.id !== socketId
    );

    // Remove from joined patients
    session.patients.joinedPatients = session.patients.joinedPatients.filter(
      patient => patient.id !== socketId
    );

    // Clean up empty sessions
    if (!session.doctor &&
      session.patients.waitingLobby.length === 0 &&
      session.patients.joinedPatients.length === 0) {
      delete sessions[sessionId];
    }
  });
}

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id} at ${new Date().toISOString()}`);

  // Send connection confirmation
  socket.emit("connected", {
    message: "Successfully connected to WebSocket server",
    socketId: socket.id,
    timestamp: new Date().toISOString()
  });

  socket.on("disconnect", (reason) => {
    console.log(`Socket disconnected: ${socket.id}, Reason: ${reason} at ${new Date().toISOString()}`);
    cleanupDisconnectedClient(socket.id);
  });

  // Handle both 'message' and individual event listeners
  socket.on("message", async (msg) => {
    try {
      const data = typeof msg === 'string' ? JSON.parse(msg) : msg;
      console.log("Received message:", data);

      switch (data.type) {
        case "preview_doctor":
          handleDoctorPreview(socket, data);
          break;
        case "join_meeting":
          if (data.role === 1) handleDoctorJoin(socket, data);
          break;
        case "waiting_lobby":
          if (data.role === 0) handlePatientJoin(socket, data);
          break;
        case "approve_patient":
          handlePatientApproval(socket, data);
          break;
        case "reject_patient":
          handlePatientRejection(socket, data);
          break;
        case "patient_leave_meeting":
          handlePatientLeaveMeeting(socket, data);
          break;
        case "doctor_end":
          handleDoctorEndMeeting(socket, data);
          break;
        case "patient_join_meeting":
          handlePatientJoinMeeting(socket, data);
          break;
        default:
          console.error("Unknown message type:", data);
          socket.emit("error", { message: "Unknown message type", type: data.type });
      }
    } catch (error) {
      console.error("Error processing message:", error);
      socket.emit("error", { message: "Error processing message", error: error.message });
    }
  });

  // Add individual event listeners for better client compatibility
  socket.on("preview_doctor", (data) => handleDoctorPreview(socket, data));
  socket.on("join_meeting", (data) => {
    if (data.role === 1) handleDoctorJoin(socket, data);
  });
  socket.on("waiting_lobby", (data) => {
    if (data.role === 0) handlePatientJoin(socket, data);
  });
  socket.on("approve_patient", (data) => handlePatientApproval(socket, data));
  socket.on("reject_patient", (data) => handlePatientRejection(socket, data));
  socket.on("patient_leave_meeting", (data) => handlePatientLeaveMeeting(socket, data));
  socket.on("doctor_end", (data) => handleDoctorEndMeeting(socket, data));
  socket.on("patient_join_meeting", (data) => handlePatientJoinMeeting(socket, data));

  socket.on("error", (error) => {
    console.error("Socket.IO error:", error);
  });

  // Handle ping/pong for connection health
  socket.on("ping", () => {
    socket.emit("pong", { timestamp: Date.now() });
  });
});

// Enhanced error handling
io.engine.on("connection_error", (err) => {
  console.log("Connection error details:", err.req);
  console.log("Error code:", err.code);
  console.log("Error message:", err.message);
  console.log("Error context:", err.context);
});

// Use environment port or default to 8080
const PORT = process.env.PORT || 8080;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`WebSocket server listening on *:${PORT} at ${new Date().toISOString()}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});