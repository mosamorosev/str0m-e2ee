/**
 * E2EE WebRTC Client — Main Application
 *
 * Connects to a str0m SFU, establishes WebRTC peer connections,
 * and applies E2EE transforms via Insertable Streams.
 *
 * C0 Prototype: 1:1 call with hardcoded shared key.
 */

import { E2EEKeyManager } from './crypto.js';
import { KeyExchangeManager } from './key-exchange.js';
import { RekeyScheduler } from './rekey.js';
import { E2EE_CHANNEL_LABEL } from './e2ee-contract.js';

// ─── State ────────────────────────────────────────────────
let rtc = null;
let dataChannel = null;        // SDP renegotiation channel
let e2eeChannel = null;        // E2EE key exchange channel
let streamCam = null;
let streamMic = null;
let e2ee = null;
let keyExchange = null;
let rekeyScheduler = null;
let negotiateCallback = null;

// Shared key for C0 prototype fallback (used if key exchange is not available)
const SHARED_KEY = new Uint8Array([
    0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10
]);

// ─── DOM Helpers ──────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function setStatus(id, text, className) {
    const el = $(id);
    if (el) {
        el.textContent = text;
        if (className) el.className = className;
    }
}

function log(msg) {
    console.log(`[E2EE Client] ${msg}`);
    const logEl = $('log');
    if (logEl) {
        const line = document.createElement('div');
        line.textContent = `${new Date().toISOString().slice(11, 19)} ${msg}`;
        logEl.appendChild(line);
        logEl.scrollTop = logEl.scrollHeight;
    }
}

// ─── WebRTC Connection ────────────────────────────────────

/**
 * Create the RTCPeerConnection with E2EE encoded transform support.
 */
function createPeerConnection() {
    // encodedInsertableStreams enables the legacy API path if needed
    rtc = new RTCPeerConnection({
        encodedInsertableStreams: true
    });

    rtc.oniceconnectionstatechange = () => {
        setStatus('ice-status', rtc.iceConnectionState);
        log(`ICE state: ${rtc.iceConnectionState}`);

        if (rtc.iceConnectionState === 'disconnected' || rtc.iceConnectionState === 'failed') {
            cleanup();
        }
    };

    rtc.ontrack = (event) => {
        log(`Received track: ${event.track.kind} (id: ${event.track.id})`);
        handleIncomingTrack(event);
    };
}

/**
 * Handle incoming media tracks — attach E2EE decrypt transform and render.
 */
function handleIncomingTrack(event) {
    const track = event.track;
    const receiver = event.receiver;

    // Attach E2EE decrypt transform
    e2ee.setupReceiverTransform(receiver);

    // Create media element for rendering
    const domId = `media-${track.id}`;
    if ($(domId)) return; // Already have this track

    const el = document.createElement('video');
    el.id = domId;
    el.width = 500;
    el.controls = true;
    el.autoplay = true;
    el.playsInline = true;

    $('media').appendChild(el);

    // Use setTimeout to avoid race with track setup
    setTimeout(() => {
        const stream = new MediaStream();
        stream.addTrack(track);
        el.srcObject = stream;
    }, 1);

    track.addEventListener('mute', () => {
        log(`Track muted: ${track.kind}`);
        el.style.display = 'none';
    });

    track.addEventListener('unmute', () => {
        log(`Track unmuted: ${track.kind}`);
        el.style.display = '';
    });
}

// ─── SDP Negotiation ──────────────────────────────────────

/**
 * Negotiate via DataChannel (used after initial connection).
 */
async function negotiate() {
    const offer = await rtc.createOffer();
    await rtc.setLocalDescription(offer);
    log('Sending SDP offer via DataChannel');

    dataChannel.send(JSON.stringify(offer));

    // Wait for answer via DataChannel
    const answerJson = await new Promise((resolve) => {
        negotiateCallback = resolve;
    });

    const answer = JSON.parse(answerJson);
    await rtc.setRemoteDescription(answer);
    log('SDP negotiation complete');
}

/**
 * Handle an incoming SDP offer (from SFU via DataChannel).
 */
async function handleOffer(json) {
    const offer = JSON.parse(json);
    await rtc.setRemoteDescription(offer);

    const answer = await rtc.createAnswer();
    await rtc.setLocalDescription(answer);

    dataChannel.send(JSON.stringify(answer));
    log('Handled incoming SDP offer, sent answer');
}

// ─── User Actions ─────────────────────────────────────────

/**
 * Connect to the SFU.
 */
async function connect() {
    $('btn-connect').disabled = true;
    log('Connecting to SFU...');

    // Check E2EE support
    const support = E2EEKeyManager.checkSupport();
    log(`E2EE API: ${support.api} — ${support.details}`);

    if (!support.supported) {
        setStatus('e2ee-status', 'NOT SUPPORTED', 'status-off');
        log('ERROR: Insertable Streams not supported in this browser');
        return;
    }

    // Initialize E2EE with key exchange
    e2ee = new E2EEKeyManager();
    keyExchange = new KeyExchangeManager(e2ee, (status) => {
        // Update UI when key exchange status changes
        if (status.allKeysEstablished) {
            setStatus('e2ee-status', `E2EE ON (${status.participantCount} peers)`, 'status-on');
        } else {
            setStatus('e2ee-status', `KEYS PENDING (${status.participantCount} peers)`, 'status-pending');
        }
        setStatus('participant-count', String(status.participantCount));
        setStatus('epoch-status', String(status.epoch));
        log(`Key exchange status: ${JSON.stringify(status)}`);
    });
    await keyExchange.init();

    // Initialize rekey scheduler
    rekeyScheduler = new RekeyScheduler(keyExchange);
    rekeyScheduler.start();

    // Initialize shared key as fallback (for 1:1 prototype testing)
    await e2ee.initSharedKey(SHARED_KEY);
    setStatus('e2ee-status', 'KEYS SET', 'status-pending');

    // Create peer connection
    createPeerConnection();

    // Create DataChannel for SDP renegotiation
    dataChannel = rtc.createDataChannel('offer/answer');
    dataChannel.onopen = () => {
        log('DataChannel open');
        $('btn-cam').disabled = false;
        $('btn-cam-simulcast').disabled = false;
        $('btn-mic').disabled = false;
        $('btn-rekey').disabled = false;
        $('btn-disconnect').disabled = false;
        setStatus('dc-status', 'open');
    };
    dataChannel.onmessage = (event) => {
        const json = JSON.parse(event.data);
        if (json.type === 'offer') {
            handleOffer(event.data);
        } else if (json.type === 'answer') {
            if (negotiateCallback) {
                negotiateCallback(event.data);
                negotiateCallback = null;
            }
        }
    };

    // Create E2EE key exchange DataChannel
    e2eeChannel = rtc.createDataChannel(E2EE_CHANNEL_LABEL);
    keyExchange.attachChannel(e2eeChannel);

    // Create initial SDP offer and send to SFU via HTTP
    const offer = await rtc.createOffer();
    await rtc.setLocalDescription(offer);

    const res = await fetch('/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(offer),
    });

    const answer = await res.json();
    await rtc.setRemoteDescription(answer);
    log('Connected to SFU');
    setStatus('ice-status', rtc.iceConnectionState);
}

/**
 * Start camera and add video track with E2EE.
 */
async function startCamera() {
    $('btn-cam').disabled = true;
    log('Starting camera...');

    try {
        streamCam = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 360 }
        });

        const track = streamCam.getTracks()[0];
        const transceiver = rtc.addTransceiver(track, {
            direction: 'sendonly',
            streams: [streamCam],
        });

        // Attach E2EE encrypt transform to the sender
        e2ee.setupSenderTransform(transceiver.sender);

        await negotiate();

        setStatus('e2ee-status', 'E2EE ON', 'status-on');
        log('Camera started with E2EE encryption');
        $('btn-stop-cam').disabled = false;

        // Show local preview
        const preview = $('local-preview');
        if (preview) {
            preview.srcObject = streamCam;
        }
    } catch (err) {
        log(`Camera error: ${err.message}`);
        $('btn-cam').disabled = false;
    }
}

/**
 * Start microphone and add audio track with E2EE.
 */
async function startMicrophone() {
    $('btn-mic').disabled = true;
    log('Starting microphone...');

    try {
        streamMic = await navigator.mediaDevices.getUserMedia({ audio: true });

        const track = streamMic.getTracks()[0];
        const transceiver = rtc.addTransceiver(track, {
            direction: 'sendonly',
            streams: [streamMic],
        });

        // Attach E2EE encrypt transform to the sender
        e2ee.setupSenderTransform(transceiver.sender);

        await negotiate();
        log('Microphone started with E2EE encryption');
        $('btn-stop-mic').disabled = false;
    } catch (err) {
        log(`Microphone error: ${err.message}`);
        $('btn-mic').disabled = false;
    }
}

/**
 * Start camera with simulcast (multiple quality layers).
 * SFU selects layer based on receiver bandwidth — no payload inspection needed.
 */
async function startCameraSimulcast() {
    $('btn-cam-simulcast').disabled = true;
    $('btn-cam').disabled = true;
    log('Starting camera with simulcast...');

    try {
        streamCam = await navigator.mediaDevices.getUserMedia({
            video: { width: 1280, height: 720 }
        });

        const track = streamCam.getTracks()[0];
        const transceiver = rtc.addTransceiver(track, {
            direction: 'sendonly',
            streams: [streamCam],
            sendEncodings: [
                { rid: 'h', maxBitrate: 700 * 1024 },
                { rid: 'l', maxBitrate: 150 * 1024 }
            ]
        });

        // Attach E2EE encrypt transform to the sender
        e2ee.setupSenderTransform(transceiver.sender);

        await negotiate();

        setStatus('e2ee-status', 'E2EE ON', 'status-on');
        log('Camera started with simulcast + E2EE (h=700kbps, l=150kbps)');
        $('btn-stop-cam').disabled = false;

        const preview = $('local-preview');
        if (preview) {
            preview.srcObject = streamCam;
        }
    } catch (err) {
        log(`Camera error: ${err.message}`);
        $('btn-cam-simulcast').disabled = false;
        $('btn-cam').disabled = false;
    }
}

/**
 * Trigger a manual rekey.
 */
async function triggerRekey() {
    if (!rekeyScheduler) return;
    log('Manual rekey triggered');
    await rekeyScheduler.rekeyNow();
}

/**
 * Stop the camera.
 */
function stopCamera() {
    if (streamCam) {
        streamCam.getTracks().forEach(t => t.stop());
        streamCam = null;
        log('Camera stopped');
    }
    const preview = $('local-preview');
    if (preview) preview.srcObject = null;

    $('btn-stop-cam').disabled = true;
    $('btn-cam').disabled = false;
    $('btn-cam-simulcast').disabled = false;
}

/**
 * Stop the microphone.
 */
function stopMicrophone() {
    if (streamMic) {
        streamMic.getTracks().forEach(t => t.stop());
        streamMic = null;
        log('Microphone stopped');
    }
    $('btn-stop-mic').disabled = true;
    $('btn-mic').disabled = false;
}

/**
 * Disconnect from the SFU and clean up everything.
 */
function disconnect() {
    log('Disconnecting...');
    cleanup();
    $('btn-connect').disabled = false;
    $('btn-disconnect').disabled = true;
    setStatus('ice-status', 'closed');
    setStatus('dc-status', 'closed');
    setStatus('participant-count', '0');
    setStatus('epoch-status', '0');
    log('Disconnected from SFU');
}

/**
 * Clean up all media and connections.
 */
function cleanup() {
    log('Cleaning up...');
    if (streamCam) { streamCam.getTracks().forEach(t => t.stop()); streamCam = null; }
    if (streamMic) { streamMic.getTracks().forEach(t => t.stop()); streamMic = null; }
    if (rtc) { rtc.close(); rtc = null; }
    if (e2ee) { e2ee.destroy(); e2ee = null; }
    if (rekeyScheduler) { rekeyScheduler.destroy(); rekeyScheduler = null; }
    keyExchange = null;
    dataChannel = null;
    e2eeChannel = null;
    negotiateCallback = null;

    const preview = $('local-preview');
    if (preview) preview.srcObject = null;

    // Remove all remote video elements
    const media = $('media');
    if (media) media.innerHTML = '';

    $('btn-cam').disabled = true;
    $('btn-cam-simulcast').disabled = true;
    $('btn-mic').disabled = true;
    $('btn-rekey').disabled = true;
    $('btn-stop-cam').disabled = true;
    $('btn-stop-mic').disabled = true;
    setStatus('e2ee-status', 'DISCONNECTED', 'status-off');
}

// ─── Initialize ───────────────────────────────────────────
window.connect = connect;
window.startCamera = startCamera;
window.startCameraSimulcast = startCameraSimulcast;
window.startMicrophone = startMicrophone;
window.stopCamera = stopCamera;
window.stopMicrophone = stopMicrophone;
window.disconnect = disconnect;
window.triggerRekey = triggerRekey;
