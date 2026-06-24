#!/usr/bin/env node

// PERC Key Distributor (KD) Service
//
// Implements the trusted Key Distributor role from RFC 8871.
// Manages E2E SRTP keys and EKT (Encrypted Key Transport) for conferences.
//
// Architecture:
//   - HTTPS server for REST API (conference management, endpoint join/leave)
//   - WebSocket for real-time key distribution to SFU and endpoints
//
// Key distribution flow:
//   1. SFU connects via WebSocket to /ws/sfu
//   2. Endpoint joins conference via POST /conference/:id/join
//   3. KD generates E2E master key for the endpoint
//   4. KD sends key bundle to the endpoint (KEK, E2E key, E2E salt, peer keys)
//   5. KD notifies other endpoints about the new member via WebSocket
//   6. When an endpoint leaves, KD rotates KEK and notifies remaining endpoints
//
// Usage:
//   node server.js [--config <path>] [--port PORT] [--verbose]
//
// Configuration is read from config.json (see --config resolution in
// config-loader.js). CLI flags --port / --verbose still override the file.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { ConferenceManager } = require('./conference');
const { loadConfig, get } = require('../config-loader');

const args = process.argv.slice(2);
const { config: cfg, sources: cfgSources } = loadConfig('keyDistributor', {
    port: 4000,
    logLevel: 'info',
    logging: { toFile: false, dir: 'log', timestamped: true },
});

// CLI flags take precedence over the config file.
const portFlag = args.find((_, i, a) => a[i - 1] === '--port');
const PORT = parseInt(portFlag || cfg.port || '4000', 10);
const VERBOSE =
    args.includes('--verbose') ||
    args.includes('-v') ||
    get(cfg, 'logLevel', 'info') === 'debug' ||
    get(cfg, 'logLevel', 'info') === 'trace';

const manager = new ConferenceManager();

// Track WebSocket connections
const sfuConnections = new Map();       // conferenceId → ws
const endpointConnections = new Map();  // `${conferenceId}:${endpointId}` → ws

// --- Optional file logging --------------------------------------------------
let logStream = null;
if (get(cfg, 'logging.toFile', false)) {
    const dir = get(cfg, 'logging.dir', 'log');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = get(cfg, 'logging.timestamped', true)
        ? '_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        : '';
    const file = path.join(dir, `key-distributor${stamp}.log`);
    logStream = fs.createWriteStream(file, { flags: 'a' });
}

function log(...args) {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[${ts}]`, ...args);
    if (logStream) logStream.write(`[${ts}] ${args.join(' ')}\n`);
}

function debug(...args) {
    if (VERBOSE) log('[DEBUG]', ...args);
}

if (cfgSources.length) log(`Config loaded from: ${cfgSources.join(', ')}`);

// ─── HTTP Server ──────────────────────────────────────────

function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const method = req.method;

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const path = url.pathname;

    // Route: POST /conference — create a new conference
    if (method === 'POST' && path === '/conference') {
        readBody(req, (body) => {
            const conferenceId = body.conferenceId || crypto.randomBytes(4).toString('hex');
            const conf = manager.createConference(conferenceId);
            log(`Conference created: ${conferenceId}`);
            jsonResponse(res, 201, {
                conferenceId: conf.id,
                createdAt: conf.createdAt,
            });
        });
        return;
    }

    // Route: POST /conference/:id/join — endpoint joins conference
    const joinMatch = path.match(/^\/conference\/([^/]+)\/join$/);
    if (method === 'POST' && joinMatch) {
        const conferenceId = joinMatch[1];
        readBody(req, (body) => {
            const endpointId = body.endpointId;
            const ssrcs = body.ssrcs || [];

            if (!endpointId) {
                jsonResponse(res, 400, { error: 'endpointId required' });
                return;
            }

            const { keyBundle, newMemberNotification, conference } =
                manager.join(conferenceId, endpointId, ssrcs);

            log(`Endpoint ${endpointId} joined conference ${conferenceId} (${conference.endpointCount} members)`);

            // Notify existing endpoints about new member via WebSocket
            broadcastToConference(conferenceId, endpointId, newMemberNotification);

            // Notify SFU about new endpoint
            notifySfu(conferenceId, {
                type: 'endpoint_joined',
                conferenceId,
                endpointId,
                ssrcs,
            });

            jsonResponse(res, 200, {
                status: 'joined',
                keyBundle,
            });
        });
        return;
    }

    // Route: POST /conference/:id/leave — endpoint leaves conference
    const leaveMatch = path.match(/^\/conference\/([^/]+)\/leave$/);
    if (method === 'POST' && leaveMatch) {
        const conferenceId = leaveMatch[1];
        readBody(req, (body) => {
            const endpointId = body.endpointId;

            if (!endpointId) {
                jsonResponse(res, 400, { error: 'endpointId required' });
                return;
            }

            const result = manager.leave(conferenceId, endpointId);
            if (!result) {
                jsonResponse(res, 404, { error: 'conference not found' });
                return;
            }

            log(`Endpoint ${endpointId} left conference ${conferenceId}`);

            // Remove endpoint WebSocket
            endpointConnections.delete(`${conferenceId}:${endpointId}`);

            if (result.removed) {
                log(`Conference ${conferenceId} removed (empty)`);
                sfuConnections.delete(conferenceId);
            } else if (result.rekeyBundle) {
                // Distribute new keys to remaining endpoints
                log(`Rekeying conference ${conferenceId} (member left)`);
                broadcastToConference(conferenceId, null, result.rekeyBundle);
                notifySfu(conferenceId, {
                    type: 'rekey',
                    conferenceId,
                });
            }

            // Notify SFU
            notifySfu(conferenceId, {
                type: 'endpoint_left',
                conferenceId,
                endpointId,
            });

            jsonResponse(res, 200, { status: 'left', conferenceRemoved: result.removed });
        });
        return;
    }

    // Route: GET /conference/:id — get conference info
    const infoMatch = path.match(/^\/conference\/([^/]+)$/);
    if (method === 'GET' && infoMatch) {
        const conferenceId = infoMatch[1];
        const conf = manager.getConference(conferenceId);
        if (!conf) {
            jsonResponse(res, 404, { error: 'conference not found' });
            return;
        }
        const endpoints = [];
        for (const [id, ep] of conf.endpoints) {
            endpoints.push({ id, ssrcs: ep.ssrcs, joinedAt: ep.joinedAt });
        }
        jsonResponse(res, 200, {
            conferenceId: conf.id,
            endpointCount: conf.endpointCount,
            endpoints,
            createdAt: conf.createdAt,
        });
        return;
    }

    // Route: GET /conferences — list all conferences
    if (method === 'GET' && path === '/conferences') {
        jsonResponse(res, 200, { conferences: manager.listConferences() });
        return;
    }

    // Route: GET /health
    if (method === 'GET' && path === '/health') {
        jsonResponse(res, 200, { status: 'ok', conferences: manager.conferences.size });
        return;
    }

    jsonResponse(res, 404, { error: 'not found' });
}

// ─── WebSocket ────────────────────────────────────────────

function setupWebSocket(server) {
    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws, req) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const path = url.pathname;

        // SFU connection: /ws/sfu?conference=<id>
        if (path === '/ws/sfu') {
            const conferenceId = url.searchParams.get('conference');
            if (!conferenceId) {
                ws.close(4000, 'conference parameter required');
                return;
            }
            log(`SFU connected for conference ${conferenceId}`);
            sfuConnections.set(conferenceId, ws);

            ws.on('close', () => {
                log(`SFU disconnected from conference ${conferenceId}`);
                sfuConnections.delete(conferenceId);
            });

            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data);
                    debug(`SFU message for ${conferenceId}:`, msg.type);
                    handleSfuMessage(conferenceId, msg);
                } catch (e) {
                    debug('Invalid SFU message:', e.message);
                }
            });

            // Send current conference state
            const conf = manager.getConference(conferenceId);
            if (conf) {
                wsSend(ws, {
                    type: 'conference_state',
                    conferenceId,
                    endpointCount: conf.endpointCount,
                    endpoints: Array.from(conf.endpoints.keys()),
                });
            }
            return;
        }

        // Endpoint connection: /ws/endpoint?conference=<id>&endpoint=<id>
        if (path === '/ws/endpoint') {
            const conferenceId = url.searchParams.get('conference');
            const endpointId = url.searchParams.get('endpoint');
            if (!conferenceId || !endpointId) {
                ws.close(4000, 'conference and endpoint parameters required');
                return;
            }

            const key = `${conferenceId}:${endpointId}`;
            log(`Endpoint ${endpointId} WS connected to conference ${conferenceId}`);
            endpointConnections.set(key, ws);

            // Update endpoint reference
            const conf = manager.getConference(conferenceId);
            if (conf) {
                const ep = conf.endpoints.get(endpointId);
                if (ep) ep.ws = ws;
            }

            ws.on('close', () => {
                log(`Endpoint ${endpointId} WS disconnected from conference ${conferenceId}`);
                endpointConnections.delete(key);
            });

            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data);
                    debug(`Endpoint ${endpointId} message:`, msg.type);
                    handleEndpointMessage(conferenceId, endpointId, msg);
                } catch (e) {
                    debug('Invalid endpoint message:', e.message);
                }
            });
            return;
        }

        ws.close(4004, 'unknown path');
    });
}

function handleSfuMessage(conferenceId, msg) {
    switch (msg.type) {
        case 'request_keys':
            // SFU requests current HBH key info (not E2E keys — SFU never gets those)
            const conf = manager.getConference(conferenceId);
            if (conf) {
                notifySfu(conferenceId, {
                    type: 'conference_keys',
                    conferenceId,
                    // SFU only gets endpoint SSRCs for routing, NOT E2E keys
                    endpoints: Array.from(conf.endpoints.entries()).map(([id, ep]) => ({
                        id,
                        ssrcs: ep.ssrcs,
                    })),
                });
            }
            break;
        default:
            debug(`Unknown SFU message type: ${msg.type}`);
    }
}

function handleEndpointMessage(conferenceId, endpointId, msg) {
    switch (msg.type) {
        case 'ekt_tag':
            // Endpoint sends its EKT Full Tag (encrypted E2E key) for distribution
            // Forward to other endpoints in the conference
            broadcastToConference(conferenceId, endpointId, {
                type: 'peer_ekt_tag',
                fromEndpoint: endpointId,
                ektTag: msg.ektTag,
            });
            break;
        case 'request_rekey':
            // Endpoint requests a key rotation
            const conf = manager.getConference(conferenceId);
            if (conf) {
                conf.keyManager.rotateKek();
                // Generate new E2E key for the requesting endpoint
                const ep = conf.endpoints.get(endpointId);
                if (ep) {
                    conf.keyManager.generateEndpointE2eKey(endpointId, ep.ssrcs[0] || 0);
                }
                const rekeyBundle = conf.getRekeyBundle();
                broadcastToConference(conferenceId, null, rekeyBundle);
                log(`Rekey requested by ${endpointId} in conference ${conferenceId}`);
            }
            break;
        default:
            debug(`Unknown endpoint message type: ${msg.type}`);
    }
}

// ─── Helpers ──────────────────────────────────────────────

function broadcastToConference(conferenceId, excludeEndpointId, message) {
    for (const [key, ws] of endpointConnections) {
        if (key.startsWith(`${conferenceId}:`) && !key.endsWith(`:${excludeEndpointId}`)) {
            wsSend(ws, message);
        }
    }
}

function notifySfu(conferenceId, message) {
    const ws = sfuConnections.get(conferenceId);
    if (ws && ws.readyState === 1) {
        wsSend(ws, message);
    }
}

function wsSend(ws, data) {
    if (ws.readyState === 1) {
        ws.send(JSON.stringify(data));
    }
}

function readBody(req, callback) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
        try {
            callback(JSON.parse(body || '{}'));
        } catch (e) {
            callback({});
        }
    });
}

function jsonResponse(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
}

// ─── Start ────────────────────────────────────────────────

const server = http.createServer(handleRequest);
setupWebSocket(server);

server.listen(PORT, () => {
    log(`PERC Key Distributor ready on http://localhost:${PORT}`);
    log('  POST /conference                — create conference');
    log('  POST /conference/:id/join       — endpoint joins (returns key bundle)');
    log('  POST /conference/:id/leave      — endpoint leaves (triggers rekey)');
    log('  GET  /conference/:id            — conference info');
    log('  GET  /conferences               — list all conferences');
    log('  WS   /ws/sfu?conference=<id>    — SFU real-time connection');
    log('  WS   /ws/endpoint?conference=<id>&endpoint=<id> — endpoint real-time connection');
    log('  GET  /health                    — health check');
});
