// Conference management for the PERC Key Distributor.
//
// Each conference has:
//   - A unique ID
//   - A KeyManager instance (manages KEK, E2E keys, EKT)
//   - A set of endpoints (with their connection state)
//   - An optional SFU connection

'use strict';

const { KeyManager } = require('./keys');

class Endpoint {
    constructor(id, conferenceId) {
        this.id = id;
        this.conferenceId = conferenceId;
        this.ws = null;          // WebSocket connection (if connected)
        this.ssrcs = [];         // SSRCs allocated to this endpoint
        this.joinedAt = Date.now();
    }
}

class Conference {
    constructor(id) {
        this.id = id;
        this.keyManager = new KeyManager();
        this.endpoints = new Map();  // endpointId → Endpoint
        this.sfuWs = null;           // SFU WebSocket connection
        this.createdAt = Date.now();

        // Generate initial KEK for the conference
        this.keyManager.generateKek();
    }

    addEndpoint(endpointId, ssrcs) {
        if (this.endpoints.has(endpointId)) {
            return this.endpoints.get(endpointId);
        }

        const endpoint = new Endpoint(endpointId, this.id);
        endpoint.ssrcs = ssrcs || [];

        // Generate E2E key for each SSRC the endpoint will send with
        const primarySsrc = ssrcs[0] || 0;
        this.keyManager.generateEndpointE2eKey(endpointId, primarySsrc);

        this.endpoints.set(endpointId, endpoint);
        return endpoint;
    }

    removeEndpoint(endpointId) {
        this.keyManager.removeEndpoint(endpointId);
        this.endpoints.delete(endpointId);

        // Rotate KEK when someone leaves (forward secrecy)
        if (this.endpoints.size > 0) {
            this.keyManager.rotateKek();
            return true; // signal that rekey is needed
        }
        return false;
    }

    // Get the key bundle to send to a newly joined endpoint.
    // Includes: KEK, E2E salt, own E2E key, and all other endpoints' E2E keys.
    getJoinKeyBundle(endpointId) {
        const ownBundle = this.keyManager.getEndpointKeyBundle(endpointId);
        if (!ownBundle) return null;

        const peerKeys = {};
        for (const [id, entry] of this.keyManager.endpointKeys) {
            if (id !== endpointId) {
                peerKeys[id] = {
                    masterKey: entry.masterKey.toString('base64'),
                    ssrc: entry.ssrc,
                };
            }
        }

        return {
            ...ownBundle,
            peerKeys,
            conferenceId: this.id,
        };
    }

    // Build a rekey notification for all endpoints (after KEK rotation or new member).
    getRekeyBundle() {
        return {
            type: 'rekey',
            conferenceId: this.id,
            kek: this.keyManager.kek.toString('base64'),
            kekSpi: this.keyManager.kekSpi,
            e2eSalt: this.keyManager.e2eSalt.toString('base64'),
            e2eMasterKey: this.keyManager.e2eGroupKey.toString('base64'),
            allKeys: this.keyManager.getAllE2eKeys(),
        };
    }

    get endpointCount() {
        return this.endpoints.size;
    }
}

class ConferenceManager {
    constructor() {
        this.conferences = new Map(); // conferenceId → Conference
    }

    createConference(conferenceId) {
        if (this.conferences.has(conferenceId)) {
            return this.conferences.get(conferenceId);
        }
        const conf = new Conference(conferenceId);
        this.conferences.set(conferenceId, conf);
        return conf;
    }

    getConference(conferenceId) {
        return this.conferences.get(conferenceId);
    }

    removeConference(conferenceId) {
        this.conferences.delete(conferenceId);
    }

    // Join: create conference if needed, add endpoint, return key bundle.
    join(conferenceId, endpointId, ssrcs) {
        let conf = this.conferences.get(conferenceId);
        if (!conf) {
            conf = this.createConference(conferenceId);
        }

        conf.addEndpoint(endpointId, ssrcs);
        const keyBundle = conf.getJoinKeyBundle(endpointId);

        // Notify existing endpoints about the new member
        const newMemberNotification = {
            type: 'new_member',
            conferenceId,
            endpointId,
            e2eKey: conf.keyManager.endpointKeys.get(endpointId).masterKey.toString('base64'),
            ssrc: ssrcs[0] || 0,
        };

        return { keyBundle, newMemberNotification, conference: conf };
    }

    // Leave: remove endpoint, rotate keys if needed.
    leave(conferenceId, endpointId) {
        const conf = this.conferences.get(conferenceId);
        if (!conf) return null;

        const needsRekey = conf.removeEndpoint(endpointId);

        if (conf.endpointCount === 0) {
            this.conferences.delete(conferenceId);
            return { removed: true, rekeyBundle: null };
        }

        const rekeyBundle = needsRekey ? conf.getRekeyBundle() : null;
        return { removed: false, rekeyBundle };
    }

    listConferences() {
        const list = [];
        for (const [id, conf] of this.conferences) {
            list.push({
                id,
                endpoints: conf.endpointCount,
                createdAt: conf.createdAt,
            });
        }
        return list;
    }
}

module.exports = { Conference, ConferenceManager, Endpoint };
