const readline = require("readline");
const WebSocket = require("ws");
const https = require("https");

let addon;
try {
  addon = require("./build/Release/webrtc_addon");
} catch (e) {
  console.error("Native addon not found. Build it first with: npm run build");
  console.error(e.message);
  process.exit(1);
}

// --- State ---
let ws = null;
let pc = null;
let myName = null;
let remotePeer = null;
let inCall = false;
let sfuMode = false;
let sfuUrl = null;
let sfuRoomId = null;
let sfuPollTimer = null;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt() {
  rl.question("> ", (input) => {
    handleCommand(input.trim());
    if (input.trim() !== "quit") prompt();
  });
}

function log(msg) {
  console.log(`\n[${new Date().toLocaleTimeString()}] ${msg}`);
  process.stdout.write("> ");
}

// --- Event polling ---
let pollTimer = null;

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (!pc) return;
    const events = pc.pollEvents();
    for (const evt of events) {
      handlePeerEvent(evt);
    }
  }, 50);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function handlePeerEvent(evt) {
  const data = evt.data ? JSON.parse(evt.data) : {};

  switch (evt.type) {
    case "offer_created":
      pc.setLocalDescription(data.type, data.sdp);
      if (sfuMode) {
        // SFU mode: send offer via HTTP POST
        sfuSendOffer(data.sdp);
      } else {
        sendSignal({ type: "offer", sdp: data.sdp });
      }
      log("Offer created and sent.");
      break;

    case "answer_created":
      pc.setLocalDescription(data.type, data.sdp);
      if (sfuMode) {
        // In SFU mode, we shouldn't create answers (SFU gives us the answer)
        log("Warning: answer_created in SFU mode (unexpected).");
      } else {
        sendSignal({ type: "answer", sdp: data.sdp });
      }
      log("Answer created and sent to peer.");
      break;

    case "ice_candidate":
      if (sfuMode) {
        // In SFU tunnel mode, ICE candidates are embedded in the SDP (ICE-lite).
        // Trickle ICE is not used — ignore individual candidates.
      } else {
        sendSignal({ type: "ice_candidate", candidate: data });
      }
      break;

    case "ice_connection_state":
      log(`ICE connection state: ${data.state}`);
      break;

    case "connection_state":
      log(`Connection state: ${data.state}`);
      if (data.state === "connected") {
        log("P2P connection established!");
      } else if (data.state === "failed" || data.state === "disconnected") {
        log("P2P connection lost.");
      }
      break;

    case "ice_gathering_complete":
      log("ICE gathering complete.");
      break;

    case "local_description_set":
    case "remote_description_set":
      break;

    case "remote_audio_track":
      log("Remote audio track received — audio should be playing.");
      break;

    case "remote_video_track":
      log("Remote video track received — video window should open.");
      break;

    case "error":
      log(`Error: ${data.message}`);
      break;
  }
}

// --- SFU HTTP signaling ---

function sfuHttpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, sfuUrl);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      rejectUnauthorized: false, // self-signed certs
      headers: body
        ? { "Content-Type": "application/json" }
        : {},
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON from SFU: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function sfuSendOffer(sdp) {
  try {
    const result = await sfuHttpRequest("POST", "/offer", {
      type: "offer",
      sdp,
    });

    if (result.status === "waiting") {
      // First client — need to poll for answer
      sfuRoomId = result.room_id;
      log(`Joined room ${sfuRoomId}. Waiting for peer...`);
      sfuStartPollingAnswer();
    } else if (result.sdp) {
      // Second client — got answer immediately
      log("Paired with peer! Setting remote answer...");
      pc.setRemoteDescription("answer", result.sdp);
    } else {
      log(`Unexpected SFU response: ${JSON.stringify(result)}`);
    }
  } catch (e) {
    log(`SFU offer error: ${e.message}`);
  }
}

function sfuStartPollingAnswer() {
  if (sfuPollTimer) return;
  log("Polling SFU for answer...");
  sfuPollTimer = setInterval(async () => {
    try {
      const result = await sfuHttpRequest(
        "GET",
        `/answer?room=${sfuRoomId}`,
        null
      );

      if (result.sdp) {
        // Got the answer!
        clearInterval(sfuPollTimer);
        sfuPollTimer = null;
        log("Received answer from SFU. Setting remote description...");
        pc.setRemoteDescription("answer", result.sdp);
      }
      // else status: "waiting" — keep polling
    } catch (e) {
      log(`SFU poll error: ${e.message}`);
    }
  }, 1000);
}

// --- WebSocket signaling ---

function sendSignal(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function handleSignalingMessage(msg) {
  switch (msg.type) {
    case "registered":
      log(`Connected to server as "${msg.name}".`);
      break;

    case "peer_joined":
      remotePeer = msg.name;
      log(`Peer joined: "${msg.name}". You can now type 'call' to start a call.`);
      break;

    case "peer_left":
      log(`Peer left: "${msg.name}".`);
      if (inCall) {
        endCall();
        log("Call ended (peer disconnected).");
      }
      remotePeer = null;
      break;

    case "offer":
      log(`Incoming call from "${remotePeer || "peer"}"!`);
      log('Type "answer" to accept the call.');
      // Store the offer to apply when user types 'answer'
      pendingOffer = msg;
      break;

    case "answer":
      if (pc) {
        pc.setRemoteDescription("answer", msg.sdp);
        log("Remote answer received. Connecting...");
      }
      break;

    case "ice_candidate":
      if (pc && msg.candidate) {
        pc.addIceCandidate(
          msg.candidate.sdpMid,
          msg.candidate.sdpMLineIndex,
          msg.candidate.candidate
        );
      }
      break;

    case "hangup":
      log("Remote peer ended the call.");
      endCall();
      break;

    case "error":
      log(`Server error: ${msg.message}`);
      break;
  }
}

let pendingOffer = null;

// --- Commands ---

function handleCommand(input) {
  const parts = input.split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  switch (cmd) {
    case "connect": {
      if (ws) {
        log("Already connected. Disconnect first.");
        break;
      }
      const name = parts[1];
      const server = parts[2] || "ws://localhost:8080";
      if (!name) {
        log("Usage: connect <yourname> [server_url]");
        break;
      }
      myName = name;
      ws = new WebSocket(server);
      ws.on("open", () => {
        sendSignal({ type: "register", name: myName });
      });
      ws.on("message", (data) => {
        try {
          handleSignalingMessage(JSON.parse(data));
        } catch {}
      });
      ws.on("close", () => {
        log("Disconnected from server.");
        ws = null;
      });
      ws.on("error", (err) => {
        log(`Connection error: ${err.message}`);
        ws = null;
      });
      break;
    }

    case "connect-sfu": {
      if (sfuMode || ws) {
        log("Already connected. Disconnect first.");
        break;
      }
      const name = parts[1];
      const url = parts[2] || "https://localhost:3000";
      if (!name) {
        log("Usage: connect-sfu <yourname> <sfu-url>");
        log("  e.g.: connect-sfu alice https://10.8.1.113:3000");
        break;
      }
      myName = name;
      sfuUrl = url;
      sfuMode = true;

      // Create PeerConnection and send offer to SFU
      // Role 0 = caller (sends audio + video)
      pc = new addon.PeerConnection(0, myName);
      inCall = true;
      startPolling();
      pc.createOffer();
      log(`Connecting to SFU at ${sfuUrl} as "${myName}"...`);
      break;
    }

    case "call": {
      if (!ws && !sfuMode) {
        log("Not connected. Use 'connect <name>' or 'connect-sfu <name> <url>' first.");
        break;
      }
      if (!remotePeer) {
        log("No peer available. Wait for another client to connect.");
        break;
      }
      if (inCall) {
        log("Already in a call. Use 'end' to hang up first.");
        break;
      }
      // Create PeerConnection as caller (role 0 = sends audio + video)
      pc = new addon.PeerConnection(0, myName);
      inCall = true;
      startPolling();
      pc.createOffer();
      log(`Calling "${remotePeer}"...`);
      break;
    }

    case "answer": {
      if (!ws) {
        log("Not connected.");
        break;
      }
      if (!pendingOffer) {
        log("No incoming call to answer.");
        break;
      }
      // Create PeerConnection as callee (role 1 = receive audio + video)
      pc = new addon.PeerConnection(1, myName);
      inCall = true;
      startPolling();
      pc.setRemoteDescription("offer", pendingOffer.sdp);
      pc.createAnswer();
      pendingOffer = null;
      log("Answering call...");
      break;
    }

    case "end": {
      if (!inCall) {
        log("Not in a call.");
        break;
      }
      if (!sfuMode) sendSignal({ type: "hangup" });
      endCall();
      log("Call ended.");
      break;
    }

    case "disconnect": {
      if (!ws && !sfuMode) {
        log("Not connected.");
        break;
      }
      if (inCall) {
        if (!sfuMode) sendSignal({ type: "hangup" });
        endCall();
      }
      if (sfuPollTimer) {
        clearInterval(sfuPollTimer);
        sfuPollTimer = null;
      }
      if (ws) ws.close();
      ws = null;
      sfuMode = false;
      sfuUrl = null;
      sfuRoomId = null;
      myName = null;
      remotePeer = null;
      log("Disconnected.");
      break;
    }

    case "status": {
      log(
        `Name: ${myName || "(none)"} | ` +
          `Mode: ${sfuMode ? "SFU" : ws ? "P2P" : "disconnected"} | ` +
          `SFU: ${sfuUrl || "(none)"} | ` +
          `Room: ${sfuRoomId || "(none)"} | ` +
          `Peer: ${remotePeer || "(none)"} | ` +
          `Call: ${inCall ? "active" : "inactive"}`
      );
      break;
    }

    case "audioinfo": {
      if (!pc) {
        log("No active PeerConnection. Start a call first.");
        break;
      }
      try {
        const info = JSON.parse(pc.getAudioInfo());
        log("Audio info: " + JSON.stringify(info, null, 2));
      } catch (e) {
        log("Failed to get audio info: " + e.message);
      }
      break;
    }

    case "videoinfo": {
      if (!pc) {
        log("No active PeerConnection. Start a call first.");
        break;
      }
      try {
        const info = JSON.parse(pc.getVideoInfo());
        log("Video info: " + JSON.stringify(info, null, 2));
      } catch (e) {
        log("Failed to get video info: " + e.message);
      }
      break;
    }

    case "help": {
      console.log(`
Commands:
  === P2P Mode (via WebSocket signaling server) ===
  connect <name> [server]       - Connect to signaling server (default: ws://localhost:8080)
  call                          - Start a call (you send audio + video)
  answer                        - Answer an incoming call (you see/hear caller)

  === SFU Tunnel Mode (via str0m E2EE SFU) ===
  connect-sfu <name> <sfu-url>  - Connect to tunnel SFU (e.g. https://10.8.1.113:3000)
                                  Creates offer and sends to SFU automatically.
                                  Two clients in same SFU are paired for E2EE tunnel.

  === General ===
  end                           - End the current call
  disconnect                    - Disconnect from server/SFU
  status                        - Show current status
  audioinfo                     - Show audio device diagnostics
  videoinfo                     - Show video track diagnostics
  quit                          - Exit
`);
      break;
    }

    case "quit": {
      if (inCall) {
        if (!sfuMode) sendSignal({ type: "hangup" });
        endCall();
      }
      if (ws) ws.close();
      stopPolling();
      rl.close();
      process.exit(0);
      break;
    }

    default:
      if (cmd) log('Unknown command. Type "help" for available commands.');
      break;
  }
}

function endCall() {
  inCall = false;
  stopPolling();
  if (sfuPollTimer) {
    clearInterval(sfuPollTimer);
    sfuPollTimer = null;
  }
  if (pc) {
    pc.close();
    pc = null;
  }
  pendingOffer = null;
}

// --- Main ---
console.log("=== WebRTC Demo Client (P2P + SFU Tunnel) ===");
console.log('Type "help" for available commands.\n');
prompt();
