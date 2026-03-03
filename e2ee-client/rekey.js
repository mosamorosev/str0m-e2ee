/**
 * E2EE Rekey Manager
 *
 * Handles key rotation, anti-replay protection, and epoch transitions.
 * Wraps the KeyExchangeManager with:
 *   - Periodic rekey timer
 *   - Anti-replay sliding window per sender
 *   - Epoch overlap during transitions
 *   - HKDF-based key ratchet for catch-up
 */

const REKEY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const EPOCH_OVERLAP_MS = 2000;            // 2 second overlap window
const REPLAY_WINDOW_SIZE = 1024;          // frames

/**
 * Anti-replay window — tracks which frame counters have been seen
 * for a given sender to prevent replay attacks.
 */
export class ReplayWindow {
    constructor(windowSize = REPLAY_WINDOW_SIZE) {
        this.windowSize = windowSize;
        this.highestCounter = -1n;
        this.bitmap = new Set(); // counters within the window that have been seen
    }

    /**
     * Check if a frame counter is valid (not replayed).
     * @param {BigInt} counter
     * @returns {boolean} true if the counter is valid and should be accepted
     */
    check(counter) {
        // If counter is ahead of window, always accept
        if (counter > this.highestCounter) {
            return true;
        }

        // If counter is too old (behind the window), reject
        if (this.highestCounter - counter >= BigInt(this.windowSize)) {
            return false;
        }

        // If we've already seen this counter, reject (replay)
        if (this.bitmap.has(counter)) {
            return false;
        }

        return true;
    }

    /**
     * Mark a frame counter as seen (call after successful decryption).
     * @param {BigInt} counter
     */
    accept(counter) {
        if (counter > this.highestCounter) {
            // Advance window: remove counters that fall out
            const oldThreshold = this.highestCounter - BigInt(this.windowSize);
            for (const c of this.bitmap) {
                if (c <= oldThreshold) {
                    this.bitmap.delete(c);
                }
            }
            this.highestCounter = counter;
        }

        this.bitmap.add(counter);
    }

    /**
     * Reset the window (e.g., on epoch change).
     */
    reset() {
        this.highestCounter = -1n;
        this.bitmap.clear();
    }
}

/**
 * Rekey scheduler — manages periodic and event-driven rekeying.
 */
export class RekeyScheduler {
    /**
     * @param {KeyExchangeManager} keyExchange
     * @param {Object} options
     * @param {number} options.intervalMs - Periodic rekey interval
     * @param {number} options.overlapMs - Epoch overlap duration
     */
    constructor(keyExchange, options = {}) {
        this.keyExchange = keyExchange;
        this.intervalMs = options.intervalMs || REKEY_INTERVAL_MS;
        this.overlapMs = options.overlapMs || EPOCH_OVERLAP_MS;
        this.timer = null;
        this.replayWindows = new Map(); // senderId → ReplayWindow

        // Per-sender epoch overlap tracking
        this.activeEpochs = new Map(); // senderId → Set<epoch>
    }

    /**
     * Start the periodic rekey timer.
     */
    start() {
        this.timer = setInterval(() => {
            console.log('[Rekey] Periodic rekey triggered');
            this.keyExchange.rekey();
        }, this.intervalMs);
    }

    /**
     * Stop the periodic rekey timer.
     */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /**
     * Trigger immediate rekey (e.g., on participant leave).
     */
    async rekeyNow() {
        await this.keyExchange.rekey();
    }

    /**
     * Get or create a replay window for a sender.
     * @param {string} senderId
     * @returns {ReplayWindow}
     */
    getReplayWindow(senderId) {
        if (!this.replayWindows.has(senderId)) {
            this.replayWindows.set(senderId, new ReplayWindow());
        }
        return this.replayWindows.get(senderId);
    }

    /**
     * Handle epoch transition for a sender — allow overlap window.
     * @param {string} senderId
     * @param {number} newEpoch
     */
    handleEpochTransition(senderId, newEpoch) {
        if (!this.activeEpochs.has(senderId)) {
            this.activeEpochs.set(senderId, new Set());
        }

        const epochs = this.activeEpochs.get(senderId);
        epochs.add(newEpoch);

        // Schedule removal of old epochs after overlap window
        setTimeout(() => {
            for (const epoch of epochs) {
                if (epoch < newEpoch) {
                    epochs.delete(epoch);
                    console.log(`[Rekey] Retired epoch ${epoch} for sender ${senderId.slice(0, 8)}...`);
                }
            }
        }, this.overlapMs);
    }

    /**
     * Remove a sender's replay tracking (on leave).
     * @param {string} senderId
     */
    removeSender(senderId) {
        this.replayWindows.delete(senderId);
        this.activeEpochs.delete(senderId);
    }

    destroy() {
        this.stop();
        this.replayWindows.clear();
        this.activeEpochs.clear();
    }
}

/**
 * HKDF-based key ratchet.
 * Derives the next key from the current key, enabling catch-up
 * if a few key distribution messages are missed.
 *
 * @param {Uint8Array} currentKeyBytes - Current 16-byte AES key
 * @returns {Promise<Uint8Array>} Next 16-byte AES key
 */
export async function ratchetKey(currentKeyBytes) {
    // Import current key as HKDF base material
    const baseKey = await crypto.subtle.importKey(
        'raw',
        currentKeyBytes,
        'HKDF',
        false,
        ['deriveBits']
    );

    // Derive next key using HKDF with a fixed info string
    const nextKeyBits = await crypto.subtle.deriveBits(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new Uint8Array(16), // zero salt
            info: new TextEncoder().encode('e2ee-ratchet-v1'),
        },
        baseKey,
        128 // 16 bytes
    );

    return new Uint8Array(nextKeyBits);
}
