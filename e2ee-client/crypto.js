/**
 * E2EE Crypto Module
 *
 * Handles key generation, distribution, and management for
 * end-to-end encrypted WebRTC conferencing.
 *
 * For the C0 prototype, uses a hardcoded shared key.
 * C1 will add per-sender key management and DataChannel exchange.
 */

/**
 * E2EE key manager — manages sender and receiver keys,
 * communicates with the E2EE worker.
 */
export class E2EEKeyManager {
    constructor() {
        this.worker = new Worker('e2ee-worker.js');
        this.senderKeyBytes = null;
        this.keyId = 0;
        this.epoch = 0;
        this.enabled = false;
    }

    /**
     * Initialize with a hardcoded shared key (C0 prototype).
     * All participants must use the same key.
     *
     * @param {Uint8Array} [keyBytes] - 16-byte AES-128 key. If omitted, generates a random key.
     * @returns {Promise<Uint8Array>} The key bytes (for sharing with other participants).
     */
    async initSharedKey(keyBytes) {
        if (!keyBytes) {
            keyBytes = new Uint8Array(16);
            crypto.getRandomValues(keyBytes);
        }

        this.senderKeyBytes = keyBytes;

        // Set sender key in worker
        this.worker.postMessage({
            type: 'setSenderKey',
            data: { keyBytes: keyBytes.buffer, keyId: this.keyId, epoch: this.epoch }
        });

        // Also add as receiver key (shared key = same for send and receive)
        this.worker.postMessage({
            type: 'addReceiverKey',
            data: { keyBytes: keyBytes.buffer, keyId: this.keyId, epoch: this.epoch }
        });

        this.enabled = true;
        console.log('[E2EE] Shared key initialized');
        return keyBytes;
    }

    /**
     * Attach E2EE encrypt transform to an RTCRtpSender.
     * @param {RTCRtpSender} sender
     */
    setupSenderTransform(sender) {
        if (!this.enabled) return;

        if (typeof RTCRtpScriptTransform !== 'undefined') {
            // Modern API (Chrome 128+)
            sender.transform = new RTCRtpScriptTransform(this.worker, {
                direction: 'encrypt'
            });
            console.log('[E2EE] Sender transform attached (RTCRtpScriptTransform)');
        } else if (sender.createEncodedStreams) {
            // Legacy API fallback
            const { readable, writable } = sender.createEncodedStreams();
            const transformStream = new TransformStream({
                transform: async (frame, controller) => {
                    this.worker.postMessage({
                        type: 'encryptFrame',
                        data: { frame }
                    }, [frame]);
                }
            });
            readable.pipeThrough(transformStream).pipeTo(writable);
            console.log('[E2EE] Sender transform attached (createEncodedStreams)');
        } else {
            console.warn('[E2EE] No Insertable Streams API available');
        }
    }

    /**
     * Attach E2EE decrypt transform to an RTCRtpReceiver.
     * @param {RTCRtpReceiver} receiver
     */
    setupReceiverTransform(receiver) {
        if (!this.enabled) return;

        if (typeof RTCRtpScriptTransform !== 'undefined') {
            receiver.transform = new RTCRtpScriptTransform(this.worker, {
                direction: 'decrypt'
            });
            console.log('[E2EE] Receiver transform attached (RTCRtpScriptTransform)');
        } else if (receiver.createEncodedStreams) {
            const { readable, writable } = receiver.createEncodedStreams();
            const transformStream = new TransformStream({
                transform: async (frame, controller) => {
                    this.worker.postMessage({
                        type: 'decryptFrame',
                        data: { frame }
                    }, [frame]);
                }
            });
            readable.pipeThrough(transformStream).pipeTo(writable);
            console.log('[E2EE] Receiver transform attached (createEncodedStreams)');
        } else {
            console.warn('[E2EE] No Insertable Streams API available');
        }
    }

    /**
     * Check if the browser supports the required APIs.
     * @returns {{ supported: boolean, api: string, details: string }}
     */
    static checkSupport() {
        if (typeof RTCRtpScriptTransform !== 'undefined') {
            return {
                supported: true,
                api: 'RTCRtpScriptTransform',
                details: 'Modern Insertable Streams API (recommended)'
            };
        }

        // Check legacy API
        const pc = new RTCPeerConnection();
        const sender = pc.addTransceiver('audio').sender;
        const hasLegacy = typeof sender.createEncodedStreams === 'function';
        pc.close();

        if (hasLegacy) {
            return {
                supported: true,
                api: 'createEncodedStreams',
                details: 'Legacy Insertable Streams API'
            };
        }

        return {
            supported: false,
            api: 'none',
            details: 'Insertable Streams not available. Chrome 86+ required.'
        };
    }

    /**
     * Get the current E2EE status for UI display.
     * @returns {{ enabled: boolean, keyId: number, epoch: number }}
     */
    getStatus() {
        return {
            enabled: this.enabled,
            keyId: this.keyId,
            epoch: this.epoch
        };
    }

    /**
     * Clean up resources.
     */
    destroy() {
        this.worker.terminate();
        this.enabled = false;
    }
}
