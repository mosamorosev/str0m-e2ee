/**
 * E2EE Transform Worker
 *
 * Runs in a dedicated worker context via RTCRtpScriptTransform.
 * Handles frame-level AES-128-GCM encryption and decryption using
 * the Insertable Streams API.
 *
 * E2EE Frame Format (prepended to RTP payload):
 *   [KeyID: 1B][Epoch: 1B][Counter: 6B][...Ciphertext...][GCM Tag: 16B]
 *
 * Nonce (12 bytes for AES-GCM):
 *   [SSRC: 4B][Counter: 8B]
 *   The SSRC comes from frame metadata; only the lower 6 bytes of
 *   the counter are stored in the header (upper 2 bytes are zero-padded).
 */

const E2EE_HEADER_SIZE = 12; // 1 (KeyID) + 1 (Epoch) + 4 (SSRC) + 6 (Counter)
const GCM_TAG_SIZE = 16;
const COUNTER_BYTES_IN_HEADER = 6;

// Keying material: set via postMessage from the main thread
let senderKey = null;     // CryptoKey for encrypting outgoing frames
let receiverKeys = {};    // { `${keyId}-${epoch}`: CryptoKey } for decrypting
let keyId = 0;
let epoch = 0;
let frameCounter = 0n;    // BigInt counter, monotonically increasing per sender
let ssrc = 0;             // Set from frame metadata on first frame

/**
 * Convert a BigInt counter to a 6-byte Uint8Array (big-endian, lower 6 bytes).
 */
function counterToBytes(counter) {
    const buf = new Uint8Array(COUNTER_BYTES_IN_HEADER);
    let val = counter;
    for (let i = COUNTER_BYTES_IN_HEADER - 1; i >= 0; i--) {
        buf[i] = Number(val & 0xFFn);
        val >>= 8n;
    }
    return buf;
}

/**
 * Read a 6-byte big-endian counter from a Uint8Array into a BigInt.
 */
function bytesToCounter(buf, offset) {
    let val = 0n;
    for (let i = 0; i < COUNTER_BYTES_IN_HEADER; i++) {
        val = (val << 8n) | BigInt(buf[offset + i]);
    }
    return val;
}

/**
 * Build the 12-byte AES-GCM nonce from SSRC and counter.
 *   [SSRC: 4B (big-endian)][Counter: 8B (big-endian, zero-padded high 2B)]
 */
function buildNonce(ssrcValue, counter) {
    const nonce = new Uint8Array(12);
    // SSRC in first 4 bytes (big-endian)
    nonce[0] = (ssrcValue >> 24) & 0xFF;
    nonce[1] = (ssrcValue >> 16) & 0xFF;
    nonce[2] = (ssrcValue >> 8) & 0xFF;
    nonce[3] = ssrcValue & 0xFF;
    // Counter in last 8 bytes (big-endian, upper 2 bytes are 0)
    const counterBytes = counterToBytes(counter);
    nonce.set(counterBytes, 6); // offset 6 = 4 (SSRC) + 2 (zero pad)
    return nonce;
}

/**
 * Encrypt a single encoded frame.
 */
async function encryptFrame(frame, controller) {
    if (!senderKey) {
        // No key yet — pass through unencrypted
        controller.enqueue(frame);
        return;
    }

    try {
        const data = new Uint8Array(frame.data);

        // Get SSRC from frame metadata (synchronizationSource)
        if (frame.getMetadata) {
            const meta = frame.getMetadata();
            if (meta.synchronizationSource) {
                ssrc = meta.synchronizationSource;
            }
        }

        const currentCounter = frameCounter;
        frameCounter += 1n;

        // Build nonce
        const nonce = buildNonce(ssrc, currentCounter);

        // Encrypt with AES-128-GCM
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: nonce, tagLength: GCM_TAG_SIZE * 8 },
            senderKey,
            data
        );

        // Build output: [KeyID][Epoch][SSRC(4B)][Counter(6B)][Ciphertext+Tag]
        const header = new Uint8Array(E2EE_HEADER_SIZE);
        header[0] = keyId;
        header[1] = epoch;
        // Embed sender SSRC in header bytes 2-5
        header[2] = (ssrc >> 24) & 0xFF;
        header[3] = (ssrc >> 16) & 0xFF;
        header[4] = (ssrc >> 8) & 0xFF;
        header[5] = ssrc & 0xFF;
        header.set(counterToBytes(currentCounter), 6);

        const output = new Uint8Array(E2EE_HEADER_SIZE + ciphertext.byteLength);
        output.set(header, 0);
        output.set(new Uint8Array(ciphertext), E2EE_HEADER_SIZE);

        frame.data = output.buffer;
        controller.enqueue(frame);
    } catch (e) {
        console.error('[E2EE Worker] Encrypt error:', e);
        // Drop frame on encryption failure
    }
}

/**
 * Decrypt a single encoded frame.
 */
async function decryptFrame(frame, controller) {
    try {
        const data = new Uint8Array(frame.data);

        // Minimum size: header + at least GCM tag
        if (data.byteLength < E2EE_HEADER_SIZE + GCM_TAG_SIZE) {
            // Too small to be encrypted — might be unencrypted, pass through
            controller.enqueue(frame);
            return;
        }

        // Parse E2EE header
        const rxKeyId = data[0];
        const rxEpoch = data[1];
        // Read original sender SSRC from header bytes 2-5
        const rxSsrc = (data[2] << 24) | (data[3] << 16) | (data[4] << 8) | data[5];
        const rxCounter = bytesToCounter(data, 6);

        // Look up decryption key
        const lookupKey = `${rxKeyId}-${rxEpoch}`;
        const decKey = receiverKeys[lookupKey];
        if (!decKey) {
            console.warn(`[E2EE Worker] No key for KeyID=${rxKeyId} Epoch=${rxEpoch}`);
            // Drop frame — cannot decrypt
            return;
        }

        // Build nonce
        const nonce = buildNonce(rxSsrc, rxCounter);

        // Decrypt (ciphertext includes GCM tag appended by SubtleCrypto)
        const encryptedData = data.slice(E2EE_HEADER_SIZE);
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: nonce, tagLength: GCM_TAG_SIZE * 8 },
            decKey,
            encryptedData
        );

        frame.data = plaintext;
        controller.enqueue(frame);
    } catch (e) {
        // Decryption failure — likely wrong key or corrupted frame
        console.error('[E2EE Worker] Decrypt error:', e);
    }
}

/**
 * Handle messages from the main thread (key updates, configuration).
 */
self.onmessage = async (event) => {
    const { type, data } = event.data;

    switch (type) {
        case 'setSenderKey': {
            // Import raw key bytes as AES-GCM CryptoKey
            senderKey = await crypto.subtle.importKey(
                'raw',
                data.keyBytes,
                { name: 'AES-GCM', length: 128 },
                false,
                ['encrypt']
            );
            keyId = data.keyId || 0;
            epoch = data.epoch || 0;
            frameCounter = 0n;
            console.log(`[E2EE Worker] Sender key set: KeyID=${keyId} Epoch=${epoch}`);
            break;
        }
        case 'addReceiverKey': {
            const importedKey = await crypto.subtle.importKey(
                'raw',
                data.keyBytes,
                { name: 'AES-GCM', length: 128 },
                false,
                ['decrypt']
            );
            const lookupKey = `${data.keyId}-${data.epoch}`;
            receiverKeys[lookupKey] = importedKey;
            console.log(`[E2EE Worker] Receiver key added: ${lookupKey}`);
            break;
        }
        case 'removeReceiverKey': {
            const lookupKey = `${data.keyId}-${data.epoch}`;
            delete receiverKeys[lookupKey];
            console.log(`[E2EE Worker] Receiver key removed: ${lookupKey}`);
            break;
        }
    }
};

/**
 * Handle RTCRtpScriptTransform setup.
 * The browser calls this when the transform is attached to a sender or receiver.
 */
if (self.RTCTransformEvent) {
    self.onrtctransform = (event) => {
        const transformer = event.transformer;
        const direction = transformer.options?.direction;

        if (direction === 'encrypt') {
            transformer.readable
                .pipeThrough(new TransformStream({ transform: encryptFrame }))
                .pipeTo(transformer.writable);
        } else if (direction === 'decrypt') {
            transformer.readable
                .pipeThrough(new TransformStream({ transform: decryptFrame }))
                .pipeTo(transformer.writable);
        }
    };
}
