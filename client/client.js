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
  conference: { maxParticipants: 3 },
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
let pc = null;
let myName = null;
let inCall = false;
let sfuMode = false;
let sfuUrl = null;
let percConfId = null;
let sfuRoomId = null;
let sfuPollTimer = null;
// Dynamic renegotiation state (PERC N:N). The SFU assigns `percClientId` in the
// answer to our initial offer; we send it back on re-offers so it renegotiates
// the existing session. `percRecvSlots` tracks how many receive m-lines per kind
// we currently offer (1 = our own sendrecv line). `percRenegotiating` guards
// against overlapping re-offers. `sfuSignalTimer` polls GET /signal.
let percClientId = null;
let percRecvSlots = 1;
let percRenegotiating = false;
let sfuSignalTimer = null;

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
      // SFU mode: send offer via HTTP POST
      sfuSendOffer(data.sdp);
      log("Offer created and sent.");
      break;

    case "answer_created":
      pc.setLocalDescription(data.type, data.sdp);
      // In SFU mode, we shouldn't create answers (SFU gives us the answer)
      log("Warning: answer_created in SFU mode (unexpected).");
      log("Answer created and sent to peer.");
      break;

    case "ice_candidate":
      // In SFU mode, ICE candidates are embedded in the SDP (ICE-lite).
      // Trickle ICE is not used — ignore individual candidates.
      break;

    case "ice_connection_state":
      log(`ICE connection state: ${data.state}`);
      break;

    case "connection_state":
      log(`Connection state: ${data.state}`);
      if (data.state === "connected") {
        log("Media connection established!");
      } else if (data.state === "failed" || data.state === "disconnected") {
        log("Media connection lost.");
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
  // Carry our SFU-assigned id on re-offers so the SFU renegotiates the existing
  // session instead of treating this as a brand-new participant.
  const isReneg = percClientId !== null;
  try {
    const result = await sfuHttpRequest("POST", "/offer", {
      type: "offer",
      sdp,
      room: percConfId || get(CFG, "confId", "default"),
      name: myName || "?",
      ...(isReneg ? { client_id: percClientId } : {}),
    });

    if (result.error) {
      log(`SFU offer error: ${result.error}`);
      percRenegotiating = false;
      return;
    }

    if (typeof result.client_id === "number" && percClientId === null) {
      percClientId = result.client_id;
      log(`SFU assigned client id ${percClientId}.`);
    }

    if (result.status === "waiting") {
      // Legacy 1:1 pairing path — poll for the answer.
      sfuRoomId = result.room_id;
      log(`Joined room ${sfuRoomId}. Waiting for peer...`);
      sfuStartPollingAnswer();
    } else if (result.sdp) {
      pc.setRemoteDescription("answer", result.sdp);
      log(isReneg ? "Renegotiation answer applied." : "Connected to SFU.");
    } else {
      log(`Unexpected SFU response: ${JSON.stringify(result)}`);
    }
  } catch (e) {
    log(`SFU offer error: ${e.message}`);
  } finally {
    if (isReneg) percRenegotiating = false;
  }
}

// Poll the SFU for renegotiation instructions. When the conference grows, the
// SFU asks us to offer one receive slot per other participant; we top up
// recvonly transceivers to that count and re-offer. Idempotent: once we already
// have enough slots, instructions are ignored.
function startSignalPolling() {
  if (sfuSignalTimer) return;
  sfuSignalTimer = setInterval(async () => {
    if (!pc || percClientId === null || percRenegotiating) return;
    try {
      const result = await sfuHttpRequest(
        "GET",
        `/signal?client_id=${percClientId}`,
        null
      );
      const desired = result && typeof result.recv_slots === "number"
        ? result.recv_slots
        : 0;
      if (desired > percRecvSlots) {
        const add = desired - percRecvSlots;
        percRenegotiating = true;
        log(`Conference grew — adding ${add} receive slot(s) per kind (total ${desired}).`);
        pc.addRecvTransceivers(add, add);
        percRecvSlots = desired;
        pc.createOffer();
      }
    } catch (e) {
      // Transient poll errors are non-fatal; try again next tick.
    }
  }, 500);
}

function stopSignalPolling() {
  if (sfuSignalTimer) {
    clearInterval(sfuSignalTimer);
    sfuSignalTimer = null;
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
  // Server expects /ws/endpoint?conference=<id>&endpoint=<id> and closes the
  // socket otherwise; conferenceId/endpointId are set by joinPercConference.
  const q =
    `conference=${encodeURIComponent(conferenceId)}` +
    `&endpoint=${encodeURIComponent(endpointId || name)}`;
  const wsUrl = kd.replace(/^http/, "ws") + `/ws/endpoint?${q}`;
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
      // Connect to PERC SFU with E2EE via Key Distributor (default mode)
      // Usage: connect <name> <sfu-url> [kd-url] [conf-id]
      if (sfuMode || percMode) {
        log("Already connected. Disconnect first.");
        break;
      }
      const name = parts[1];
      const url = parts[2] || get(CFG, "sfuUrl", "https://localhost:3000");
      const kd = parts[3] || get(CFG, "kdUrl", "http://localhost:4000");
      const confId = parts[4] || get(CFG, "confId", "default");
      if (!name) {
        log("Usage: connect <name> <sfu-url> [kd-url] [conf-id]");
        log("  e.g.: connect alice https://10.8.1.113:3000 http://10.8.1.113:4000");
        break;
      }
      myName = name;
      sfuUrl = url;
      kdUrl = kd;
      sfuMode = true;
      percMode = true;
      percConfId = confId;

      // Create PeerConnection with E2EE support. The participant name is passed
      // to the native addon and used as the in-video tag for the synthetic
      // source (E2EE_VIDEO_LABEL overrides it if set before the addon loaded).
      // Receive slots are negotiated dynamically: the initial offer carries just
      // our own audio+video, and the SFU asks us to add more as peers join.
      pc = new addon.PeerConnection(0, myName);
      inCall = true;
      percClientId = null;
      percRecvSlots = 1;
      percRenegotiating = false;
      startPolling();
      startSignalPolling();

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

    case "disconnect": {
      if (!sfuMode) {
        log("Not connected.");
        break;
      }
      if (inCall) {
        endCall();
      }
      if (sfuPollTimer) {
        clearInterval(sfuPollTimer);
        sfuPollTimer = null;
      }
      sfuMode = false;
      sfuUrl = null;
      sfuRoomId = null;
      myName = null;
      log("Disconnected.");
      break;
    }

    case "status": {
      log(
        `Name: ${myName || "(none)"} | ` +
          `Mode: ${sfuMode ? "E2EE conference" : "disconnected"} | ` +
          `SFU: ${sfuUrl || "(none)"} | ` +
          `Room: ${sfuRoomId || "(none)"} | ` +
          `Call: ${inCall ? "active" : "inactive"}`
      );
      break;
    }

    case "audioinfo": {
      if (!pc) {
        log("No active PeerConnection. Connect first.");
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
        log("No active PeerConnection. Connect first.");
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
  === Multi-Party E2EE Conference (SFU + Key Distributor) ===
  connect <name> [sfu-url] [kd-url] [conf-id]
                                - Join an end-to-end encrypted conference.
                                  SFU handles HBH SRTP; KD provides the E2E key.
                                  Default SFU: https://localhost:3000
                                  Default KD: http://localhost:4000
                                  Clients sharing the same conf-id (default:
                                  "default") form one conference and exchange keys.

  === General ===
  disconnect                    - Leave the conference / disconnect from the SFU
  rekey                         - Request a conference key rotation
  status                        - Show current status
  audioinfo                     - Show audio device diagnostics
  videoinfo                     - Show video track diagnostics
  quit                          - Exit
`);
      break;
    }

    case "quit": {
      if (inCall) {
        endCall();
      }
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
  stopSignalPolling();
  if (sfuPollTimer) {
    clearInterval(sfuPollTimer);
    sfuPollTimer = null;
  }
  if (pc) {
    pc.close();
    pc = null;
    }
    percClientId = null;
  percRecvSlots = 1;
  percRenegotiating = false;
}

// --- Main ---
console.log("=== WebRTC E2EE Conference Client (PERC) ===");
if (CFG_SOURCES.length) console.log(`Config: ${CFG_SOURCES.join(", ")}`);
console.log('Type "help" for available commands.\n');
prompt();

// Auto-connect to the PERC SFU on startup if configured.
if (get(CFG, "autoConnect", false)) {
  const name = get(CFG, "autoConnectName", "") || `client-${process.pid}`;
  setTimeout(() => {
    log(`Auto-connecting as "${name}" (autoConnect=true)...`);
    handleCommand(`connect ${name}`);
  }, 250);
}
