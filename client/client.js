const readline = require("readline");
const WebSocket = require("ws");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { loadConfig, get } = require("../config-loader");

// --- Configuration ----------------------------------------------------------
const { config: CFG, sources: CFG_SOURCES } = loadConfig("client", {
  sfuUrl: "https://localhost:3000",
  kdUrl: "http://localhost:4000",
  confId: "default",
  autoConnect: false,
  autoConnectName: "",
  media: {
    video: {
      codec: "VP8",
      width: 640,
      height: 480,
      fps: 30,
      maxBitrateKbps: 1000,
      synthetic: false,
    },
    audio: { codec: "opus" },
  },
  e2ee: { rekeyOnCommand: true },
  logging: { toFile: false, dir: "log", timestamped: true },
  stats: { enabled: true, intervalSec: 5 },
  diagnostics: { e2eeFrameLog: false },
});

// Push media + diagnostics settings to the native addon via environment
// variables (read by webrtc_core.cc / e2ee_transformer.cc). This keeps the
// JS <-> native binary interface unchanged.
function applyNativeEnvFromConfig() {
  const v = get(CFG, "media.video", {});
  if (v.synthetic) process.env.E2EE_SYNTHETIC_VIDEO = "1";
  if (v.width) process.env.E2EE_VIDEO_WIDTH = String(v.width);
  if (v.height) process.env.E2EE_VIDEO_HEIGHT = String(v.height);
  if (v.fps) process.env.E2EE_VIDEO_FPS = String(v.fps);
  if (v.maxBitrateKbps) process.env.E2EE_VIDEO_BITRATE_KBPS = String(v.maxBitrateKbps);
  if (get(CFG, "diagnostics.e2eeFrameLog", false)) process.env.E2EE_FRAME_DIAG = "1";
}

// --- Optional file logging --------------------------------------------------
let logStream = null;
if (get(CFG, "logging.toFile", false)) {
  const dir = get(CFG, "logging.dir", "log");
  fs.mkdirSync(dir, { recursive: true });
  const base = get(CFG, "autoConnectName", "") || "client";
  const stamp = get(CFG, "logging.timestamped", true)
    ? "_" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    : "";
  const file = path.join(dir, `${base}${stamp}_console.log`);
  logStream = fs.createWriteStream(file, { flags: "a" });
  // Route native stderr logs ([e2ee]/[webrtc_core]) to the same file.
  process.env.E2EE_LOG_FILE = path.resolve(file);
}

applyNativeEnvFromConfig();

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

// PERC E2EE state
let kdUrl = null;
let kdWs = null;
let percMode = false;
let conferenceId = null;
let endpointId = null;

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
  if (logStream) logStream.write(`[${new Date().toLocaleTimeString()}] ${msg}\n`);
  process.stdout.write("> ");
}

// Reorder the payload types on the m=video line so the preferred codec is
// listed first, making it the negotiated default. Returns the SDP unchanged
// if the codec is not offered.
function preferVideoCodec(sdp, codec) {
  if (!codec) return sdp;
  const lines = sdp.split(/\r?\n/);
  const mIdx = lines.findIndex((l) => l.startsWith("m=video"));
  if (mIdx === -1) return sdp;

  // Collect payload types whose rtpmap matches the requested codec name.
  const wanted = new Set();
  const re = new RegExp(`^a=rtpmap:(\\d+)\\s+${codec}\\/`, "i");
  for (const l of lines) {
    const m = l.match(re);
    if (m) wanted.add(m[1]);
  }
  if (wanted.size === 0) return sdp;

  const parts = lines[mIdx].split(" ");
  const header = parts.slice(0, 3); // m=video PORT PROTO
  const pts = parts.slice(3);
  const preferred = pts.filter((p) => wanted.has(p));
  const rest = pts.filter((p) => !wanted.has(p));
  lines[mIdx] = [...header, ...preferred, ...rest].join(" ");
  return lines.join("\r\n");
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
      if (sfuMode && percMode) {
        const codec = get(CFG, "media.video.codec", "VP8");
        const munged = preferVideoCodec(data.sdp, codec);
        if (munged !== data.sdp) {
          log(`SDP munged to prefer video codec ${codec}.`);
          data.sdp = munged;
        }
      }
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

// --- PERC Key Distributor Integration ---

const http = require("http");

function kdRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, kdUrl);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: { "Content-Type": "application/json" },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function joinPercConference(kd, name, confId) {
  kdUrl = kd;

  // Create or join the shared conference. The KD returns the existing
  // conference if one with this id already exists, so all participants that
  // pass the same id share one group key.
  let conf;
  try {
    conf = await kdRequest("POST", "/conference", { conferenceId: confId });
    conferenceId = conf.conferenceId;
    log(`Using conference: ${conferenceId}`);
  } catch (e) {
    log(`KD create conference error: ${e.message}`);
    throw e;
  }

  // Join the conference
  try {
    const result = await kdRequest("POST", `/conference/${conferenceId}/join`, {
      endpointId: name,
    });
    endpointId = name;

    if (result.keyBundle) {
      installE2eKeys(result.keyBundle);
    }
    log(`Joined conference ${conferenceId} as ${name}`);

    // Connect WebSocket for real-time key updates
    connectKdWebSocket(kd, name);
  } catch (e) {
    log(`KD join error: ${e.message}`);
    throw e;
  }
}

function installE2eKeys(keyBundle) {
  if (!pc || !keyBundle) return;

  // keyBundle.e2eKey is base64-encoded AES-128-GCM key
  // keyBundle.kekSpi is the key epoch identifier
  try {
    const keyB64 = keyBundle.e2eMasterKey || keyBundle.e2eKey;
    if (!keyB64) {
      log("E2E key install skipped: no master key in bundle");
      return;
    }
    const keyBuf = Buffer.from(keyB64, "base64");
    const keyId = keyBundle.kekSpi || 0;
    const rc = pc.installE2eeKey(keyId, keyBuf);
    if (rc === 0) {
      log(`E2E key installed (key_id=${keyId}, ${keyBuf.length} bytes)`);
    } else {
      log(`E2E key install failed (rc=${rc})`);
    }
  } catch (e) {
    log(`E2E key install error: ${e.message}`);
  }
}

function connectKdWebSocket(kd, name) {
  const wsUrl = kd.replace(/^http/, "ws") + `/ws/endpoint?id=${name}`;
  try {
    kdWs = new WebSocket(wsUrl);
    kdWs.on("open", () => log("KD WebSocket connected"));
    kdWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === "key_update" && msg.keyBundle) {
          log("Received key update from KD");
          installE2eKeys(msg.keyBundle);
        } else if (msg.type === "rekey") {
          log("Conference rekey — installing new keys");
          installE2eKeys(msg);
        }
      } catch (e) {
        log(`KD WS parse error: ${e.message}`);
      }
    });
    kdWs.on("close", () => {
      log("KD WebSocket closed");
      kdWs = null;
    });
    kdWs.on("error", (e) => {
      log(`KD WebSocket error: ${e.message}`);
    });
  } catch (e) {
    log(`KD WebSocket connect error: ${e.message}`);
  }
}

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

    case "connect-perc": {
      // Connect to PERC SFU with E2EE via Key Distributor
      // Usage: connect-perc <name> <sfu-url> [kd-url] [conf-id]
      if (sfuMode || percMode || ws) {
        log("Already connected. Disconnect first.");
        break;
      }
      const name = parts[1];
      const url = parts[2] || get(CFG, "sfuUrl", "https://localhost:3000");
      const kd = parts[3] || get(CFG, "kdUrl", "http://localhost:4000");
      const confId = parts[4] || get(CFG, "confId", "default");
      if (!name) {
        log("Usage: connect-perc <name> <sfu-url> [kd-url] [conf-id]");
        log("  e.g.: connect-perc alice https://10.8.1.113:3000 http://10.8.1.113:4000");
        break;
      }
      myName = name;
      sfuUrl = url;
      kdUrl = kd;
      sfuMode = true;
      percMode = true;

      // Create PeerConnection with E2EE support
      pc = new addon.PeerConnection(0, myName);
      inCall = true;
      startPolling();

      // Join conference on Key Distributor, then create offer
      joinPercConference(kd, myName, confId).then(() => {
        pc.createOffer();
        log(`Connecting to PERC SFU at ${sfuUrl} with E2EE...`);
      }).catch((err) => {
        log(`KD error: ${err.message}. Falling back to unencrypted SFU.`);
        pc.createOffer();
      });
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

    case "rekey": {
      if (!get(CFG, "e2ee.rekeyOnCommand", true)) {
        log("Rekey-on-command is disabled in config.");
        break;
      }
      if (!percMode || !kdWs || kdWs.readyState !== WebSocket.OPEN) {
        log("Not in a PERC conference with an open KD connection.");
        break;
      }
      try {
        kdWs.send(JSON.stringify({ type: "request_rekey" }));
        log("Requested conference rekey from KD.");
      } catch (e) {
        log(`Rekey request failed: ${e.message}`);
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

  === PERC E2EE Mode (SFU + Key Distributor) ===
  connect-perc <name> <sfu-url> [kd-url] [conf-id]
                                - Connect to PERC SFU with E2E encryption
                                  SFU handles HBH SRTP; KD provides E2E keys.
                                  Default KD: http://localhost:4000
                                  Both clients must share the same conf-id
                                  (default: "default") to exchange E2E keys.

  === General ===
  end                           - End the current call
  disconnect                    - Disconnect from server/SFU
  rekey                         - Request a conference key rotation (PERC mode)
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
console.log("=== WebRTC Demo Client (P2P + SFU Tunnel + PERC E2EE) ===");
if (CFG_SOURCES.length) console.log(`Config: ${CFG_SOURCES.join(", ")}`);
console.log('Type "help" for available commands.\n');
prompt();

// Auto-connect to the PERC SFU on startup if configured.
if (get(CFG, "autoConnect", false)) {
  const name = get(CFG, "autoConnectName", "") || `client-${process.pid}`;
  setTimeout(() => {
    log(`Auto-connecting as "${name}" (autoConnect=true)...`);
    handleCommand(`connect-perc ${name}`);
  }, 250);
}
