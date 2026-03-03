/**
 * E2EE Key Exchange Protocol
 *
 * Implements per-sender key management and distribution
 * over a DataChannel relay. Uses X25519 for key exchange
 * and AES-128-GCM for media encryption.
 *
 * Protocol flow:
 *   1. Client joins → generates X25519 keypair + AES-128-GCM sender key
 *   2. Sends JoinAnnounce { participantId, publicKey } to all via DataChannel
 *   3. Existing clients encrypt their sender keys to new client's public key
 *   4. New client decrypts and stores sender keys indexed by (participantId, epoch)
 *   5. On rekey: increment epoch, generate new sender key, redistribute
 */

import {
    E2EE_CHANNEL_LABEL,
    MessageType,
    AES_KEY_LENGTH,
} from './e2ee-contract.js';

/**
 * Key exchange manager — handles per-sender key distribution
 * over the E2EE DataChannel.
 */
export class KeyExchangeManager {
    /**
     * @param {E2EEKeyManager} keyManager - The key manager to update with new keys
     * @param {Function} onStatusChange - Callback when E2EE status changes
     */
    constructor(keyManager, onStatusChange) {
        this.keyManager = keyManager;
        this.onStatusChange = onStatusChange || (() => {});

        // Our identity
        this.participantId = crypto.randomUUID();
        this.keyPair = null;       // { publicKey, privateKey } ECDH P-256 key pair
        this.senderKeyBytes = null; // Uint8Array(16) — our AES-128-GCM sender key
        this.epoch = 0;
        this.keyId = 0;

        // Other participants' keys
        // Map<participantId, { publicKey: CryptoKey, senderKeys: Map<epoch, Uint8Array> }>
        this.participants = new Map();

        // DataChannel reference
        this.dataChannel = null;
    }

    /**
     * Initialize key material and generate our sender key.
     */
    async init() {
        // Generate ECDH key pair for key exchange
        // Using P-256 because WebCrypto doesn't support X25519 deriveBits in all browsers
        this.keyPair = await crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' },
            true, // extractable (need to export public key)
            ['deriveBits']
        );

        // Generate our sender key
        this.senderKeyBytes = new Uint8Array(16);
        crypto.getRandomValues(this.senderKeyBytes);

        // Set our sender key in the worker
        this.keyManager.worker.postMessage({
            type: 'setSenderKey',
            data: {
                keyBytes: this.senderKeyBytes.buffer,
                keyId: this.keyId,
                epoch: this.epoch,
            }
        });

        // Also add as receiver key for our own SSRC (loopback)
        this.keyManager.worker.postMessage({
            type: 'addReceiverKey',
            data: {
                keyBytes: this.senderKeyBytes.buffer,
                keyId: this.keyId,
                epoch: this.epoch,
            }
        });

        console.log(`[KeyExchange] Initialized: participant=${this.participantId}`);
    }

    /**
     * Attach to a DataChannel for key exchange.
     * @param {RTCDataChannel} channel
     */
    attachChannel(channel) {
        this.dataChannel = channel;

        channel.onmessage = (event) => {
            this._handleMessage(event.data);
        };

        channel.onopen = () => {
            console.log('[KeyExchange] E2EE channel open, announcing');
            this._sendJoinAnnounce();
        };

        if (channel.readyState === 'open') {
            this._sendJoinAnnounce();
        }
    }

    /**
     * Trigger a rekey (new epoch, new sender key).
     * Call on participant join/leave or periodically.
     */
    async rekey() {
        this.epoch += 1;
        this.senderKeyBytes = new Uint8Array(16);
        crypto.getRandomValues(this.senderKeyBytes);

        // Update worker with new sender key
        this.keyManager.worker.postMessage({
            type: 'setSenderKey',
            data: {
                keyBytes: this.senderKeyBytes.buffer,
                keyId: this.keyId,
                epoch: this.epoch,
            }
        });

        // Also add as receiver key for self
        this.keyManager.worker.postMessage({
            type: 'addReceiverKey',
            data: {
                keyBytes: this.senderKeyBytes.buffer,
                keyId: this.keyId,
                epoch: this.epoch,
            }
        });

        // Distribute new sender key to all participants
        for (const [pid, info] of this.participants) {
            await this._sendSenderKey(pid, info.publicKey);
        }

        console.log(`[KeyExchange] Rekeyed to epoch ${this.epoch}`);
        this.onStatusChange(this.getStatus());
    }

    /**
     * Get current key exchange status.
     */
    getStatus() {
        const allHaveKeys = Array.from(this.participants.values())
            .every(p => p.senderKeys.size > 0);

        return {
            participantId: this.participantId,
            epoch: this.epoch,
            participantCount: this.participants.size + 1, // +1 for self
            allKeysEstablished: this.participants.size > 0 && allHaveKeys,
        };
    }

    // ─── Private Protocol Methods ─────────────────────────

    async _sendJoinAnnounce() {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') return;

        const publicKeyRaw = await crypto.subtle.exportKey('raw', this.keyPair.publicKey);

        const msg = this._encodeMessage(MessageType.JOIN_ANNOUNCE, {
            participantId: this.participantId,
            publicKey: new Uint8Array(publicKeyRaw),
        });

        this.dataChannel.send(msg);
        console.log('[KeyExchange] Sent JoinAnnounce');
    }

    async _sendSenderKey(targetId, targetPublicKey) {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') return;

        // Derive shared secret via ECDH
        const sharedBits = await crypto.subtle.deriveBits(
            { name: 'ECDH', public: targetPublicKey },
            this.keyPair.privateKey,
            256
        );

        // Use first 16 bytes of shared secret as wrapping key
        const wrapKey = await crypto.subtle.importKey(
            'raw',
            new Uint8Array(sharedBits).slice(0, 16),
            { name: 'AES-GCM', length: 128 },
            false,
            ['encrypt']
        );

        // Encrypt our sender key with the shared secret
        const iv = new Uint8Array(12);
        crypto.getRandomValues(iv);

        const encryptedKey = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, tagLength: 128 },
            wrapKey,
            this.senderKeyBytes
        );

        const msg = this._encodeMessage(MessageType.SENDER_KEY, {
            senderId: this.participantId,
            targetId: targetId,
            epoch: this.epoch,
            keyId: this.keyId,
            iv: iv,
            encryptedKey: new Uint8Array(encryptedKey),
        });

        this.dataChannel.send(msg);
    }

    async _handleMessage(data) {
        try {
            const parsed = this._decodeMessage(data);
            if (!parsed) return; // Not an E2EE message

            const { type, payload } = parsed;

            switch (type) {
                case MessageType.JOIN_ANNOUNCE:
                    await this._handleJoinAnnounce(payload);
                    break;
                case MessageType.SENDER_KEY:
                    await this._handleSenderKey(payload);
                    break;
                case MessageType.REKEY:
                    await this._handleRekey(payload);
                    break;
                case MessageType.LEAVE:
                    this._handleLeave(payload);
                    break;
            }
        } catch (e) {
            console.error('[KeyExchange] Error handling message:', e);
        }
    }

    async _handleJoinAnnounce(payload) {
        const { participantId, publicKey: publicKeyRaw } = payload;

        if (participantId === this.participantId) return; // Ignore our own

        // Import their public key
        const publicKey = await crypto.subtle.importKey(
            'raw',
            publicKeyRaw,
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            []
        );

        // Store participant info
        if (!this.participants.has(participantId)) {
            this.participants.set(participantId, {
                publicKey,
                senderKeys: new Map(),
            });
        } else {
            this.participants.get(participantId).publicKey = publicKey;
        }

        console.log(`[KeyExchange] Participant joined: ${participantId.slice(0, 8)}...`);

        // Send our sender key to the new participant
        await this._sendSenderKey(participantId, publicKey);

        this.onStatusChange(this.getStatus());
    }

    async _handleSenderKey(payload) {
        const { senderId, targetId, epoch, keyId, iv, encryptedKey } = payload;

        // Only process if targeted at us
        if (targetId !== this.participantId) return;

        const participant = this.participants.get(senderId);
        if (!participant) {
            console.warn(`[KeyExchange] Sender key from unknown participant: ${senderId.slice(0, 8)}`);
            return;
        }

        // Derive shared secret
        const sharedBits = await crypto.subtle.deriveBits(
            { name: 'ECDH', public: participant.publicKey },
            this.keyPair.privateKey,
            256
        );

        const unwrapKey = await crypto.subtle.importKey(
            'raw',
            new Uint8Array(sharedBits).slice(0, 16),
            { name: 'AES-GCM', length: 128 },
            false,
            ['decrypt']
        );

        // Decrypt the sender key
        const decryptedKey = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv, tagLength: 128 },
            unwrapKey,
            encryptedKey
        );

        const senderKeyBytes = new Uint8Array(decryptedKey);

        // Store for decryption
        participant.senderKeys.set(epoch, senderKeyBytes);

        // Add to worker as receiver key
        this.keyManager.worker.postMessage({
            type: 'addReceiverKey',
            data: {
                keyBytes: senderKeyBytes.buffer,
                keyId: keyId,
                epoch: epoch,
            }
        });

        console.log(
            `[KeyExchange] Received sender key from ${senderId.slice(0, 8)}... epoch=${epoch}`
        );

        this.onStatusChange(this.getStatus());
    }

    async _handleRekey(payload) {
        // Rekey messages follow the same pattern as SENDER_KEY
        // but indicate the old epoch should be retired after a transition window
        await this._handleSenderKey(payload);
    }

    _handleLeave(payload) {
        const { participantId } = payload;
        this.participants.delete(participantId);

        console.log(`[KeyExchange] Participant left: ${participantId.slice(0, 8)}...`);

        // Trigger rekey to exclude departed participant
        this.rekey();

        this.onStatusChange(this.getStatus());
    }

    // ─── Message Encoding/Decoding ────────────────────────
    // Simple JSON-based protocol for the prototype.
    // In production, use a compact binary format.

    _encodeMessage(type, payload) {
        return JSON.stringify({ type, payload: this._serializePayload(payload) });
    }

    _decodeMessage(data) {
        try {
            const msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
            // Only process messages with a numeric type (E2EE protocol messages)
            // Ignore SDP offer/answer messages that may be relayed by the SFU
            if (typeof msg.type !== 'number' || msg.payload === undefined || msg.payload === null) {
                return null;
            }
            return { type: msg.type, payload: this._deserializePayload(msg.payload) };
        } catch {
            return null; // Not valid JSON or not our protocol
        }
    }

    _serializePayload(payload) {
        const result = {};
        for (const [key, value] of Object.entries(payload)) {
            if (value instanceof Uint8Array) {
                result[key] = { _type: 'Uint8Array', data: Array.from(value) };
            } else {
                result[key] = value;
            }
        }
        return result;
    }

    _deserializePayload(payload) {
        const result = {};
        for (const [key, value] of Object.entries(payload)) {
            if (value && value._type === 'Uint8Array') {
                result[key] = new Uint8Array(value.data);
            } else {
                result[key] = value;
            }
        }
        return result;
    }
}
