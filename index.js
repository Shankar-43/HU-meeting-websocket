const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.get("/", (req, res) => {
  res.send("WebSocket server is running.");
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Define sessions object to store session data
const sessions = {};

function handleDoctorPreview(socket) {
  socket.send(
    JSON.stringify({
      type: "doctor_preview",
      message: "Doctor is in preview mode.",
    })
  );
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
  session.doctor = { id: socket.id, socket };
  socket.send(
    JSON.stringify({
      type: "doctor_joined",
      message: "Doctor has joined the meeting.",
    })
  );

  // Notify all patients in the waiting lobby
  session.patients.waitingLobby.forEach((patient) => {
    socket.send(
      JSON.stringify({
        type: "patient_request",
        patientId: patient.id,
        username: patient.username,
      })
    );
  });

  console.log("Session after doctor join:", sessions);
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
  session.patients.waitingLobby.push(patient); // Add to waiting lobby

  socket.send(
    JSON.stringify({
      type: "waiting",
      message: "Please wait in the lobby.",
      patientId: patient.id,
    })
  );

  if (session.doctor) {
    session.doctor.socket.send(
      JSON.stringify({
        type: "patient_request",
        patientId: patient.id,
        username: patient.username,
      })
    );
  }

  console.log("Patient added to waitingLobby:", session.patients.waitingLobby);
}

function handlePatientApproval(socket, data) {
  const sessionId = data.sessionID;
  const patientId = data.patientID;
  const session = sessions[sessionId];

  if (session && session.doctor.id === socket.id) {
    const patient = session.patients.waitingLobby.find((client) => client.id === patientId);
    if (patient) {
      patient.socket.send(
        JSON.stringify({
          type: "approved",
          message: "You are approved to join the meeting.",
          patientID: patientId,
        })
      );

      session.patients.waitingLobby = session.patients.waitingLobby.filter((client) => client.id !== patientId);
      session.patients.joinedPatients.push(patient); // Move patient to joined patients

      console.log("Patient approved:", patient);
      console.log("Current joinedPatients:", session.patients.joinedPatients);
    }
  }
}

function handlePatientRejection(socket, data) {
  const sessionId = data.sessionID;
  const patientId = data.patientID;
  const session = sessions[sessionId];

  if (session && session.doctor.id === socket.id) {
    const patient = session.patients.waitingLobby.find((client) => client.id === patientId);
    if (patient) {
      patient.socket.send(
        JSON.stringify({
          type: "rejected",
          message: "You are not allowed to join the meeting.",
        })
      );

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
        session.doctor.socket.send(
          JSON.stringify({
            type: "patient_leave",
            message: "Patient left the meeting.",
          })
        );
      }
      socket.send(
        JSON.stringify({
          type: "leave_confirmation",
          message: "You have successfully left the meeting.",
        })
      );
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
      session.doctor.socket.send(
        JSON.stringify({
          type: "patient_joined",
          message: `${patient.username} has joined the meeting.`,
        })
      );
    }

    // Ensure that the patient is added to the session's joinedPatients list
    session.patients.joinedPatients.push(patient);
    session.patients.waitingLobby = session.patients.waitingLobby.filter((p) => p.id !== patientId); // Remove from waitingLobby
    console.log("session===", session);
    socket.send(
      JSON.stringify({
        type: "joined_meeting",
        message: "You have successfully joined the meeting.",
      })
    );

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
        patient.socket.send(JSON.stringify(endMessage));
        patient.socket.disconnect(true);
      }
    });

    session.patients.waitingLobby.forEach((patient) => {
      if (patient.socket.connected) {
        patient.socket.send(JSON.stringify(endMessage));
        patient.socket.disconnect(true);
      }
    });

    session.doctor.socket.send(JSON.stringify(endMessage));
    session.doctor.socket.disconnect(true);
    delete sessions[sessionId];

    console.log("Meeting ended by doctor. All patients disconnected.");
  }
}

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on("disconnect", (reason) => {
    console.log(`Socket disconnected: ${socket.id}, Reason: ${reason}`);
  });

  socket.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg);
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
      }
    } catch (error) {
      console.error("Error processing message:", error);
    }
  });

  socket.on("error", (error) => {
    console.error("Socket.IO error:", error);
  });
});

server.listen(8080, () => {
  console.log("Listening on *:8080");
});
