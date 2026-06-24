// Unit tests for PERC Key Distributor
'use strict';

const assert = require('node:assert');
const { KeyManager, aesKeyWrap, aesKeyUnwrap } = require('./keys');
const { ConferenceManager } = require('./conference');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (e) {
        console.log(`  ✗ ${name}: ${e.message}`);
        failed++;
    }
}

console.log('AES Key Wrap (RFC 3394):');

test('wrap and unwrap 24-byte plaintext', () => {
    const kek = Buffer.alloc(16, 0xAB);
    const plaintext = Buffer.alloc(24);
    for (let i = 0; i < 24; i++) plaintext[i] = i;

    const wrapped = aesKeyWrap(kek, plaintext);
    assert.strictEqual(wrapped.length, 24 + 8); // n*8 + 8

    const unwrapped = aesKeyUnwrap(kek, wrapped);
    assert.ok(unwrapped, 'unwrap should succeed');
    assert.ok(plaintext.equals(unwrapped), 'roundtrip should preserve plaintext');
});

test('unwrap with wrong key returns null', () => {
    const kek1 = Buffer.alloc(16, 0xAB);
    const kek2 = Buffer.alloc(16, 0xCD);
    const plaintext = Buffer.alloc(16, 0x42);

    const wrapped = aesKeyWrap(kek1, plaintext);
    const unwrapped = aesKeyUnwrap(kek2, wrapped);
    assert.strictEqual(unwrapped, null);
});

test('unwrap tampered ciphertext returns null', () => {
    const kek = Buffer.alloc(16, 0xAB);
    const plaintext = Buffer.alloc(16, 0x42);

    const wrapped = aesKeyWrap(kek, plaintext);
    wrapped[5] ^= 0xFF; // tamper
    const unwrapped = aesKeyUnwrap(kek, wrapped);
    assert.strictEqual(unwrapped, null);
});

console.log('\nKeyManager:');

test('generate KEK and E2E keys', () => {
    const km = new KeyManager();
    const kekInfo = km.generateKek();
    assert.strictEqual(kekInfo.kek.length, 16);
    assert.strictEqual(kekInfo.e2eSalt.length, 12);
    assert.strictEqual(kekInfo.kekSpi, 1);

    const e2e = km.generateEndpointE2eKey('alice', 12345);
    assert.strictEqual(e2e.masterKey.length, 16);
    assert.strictEqual(e2e.ssrc, 12345);
});

test('build and parse EKT Full Tag roundtrip', () => {
    const km = new KeyManager();
    km.generateKek();
    km.generateEndpointE2eKey('alice', 0xDEADBEEF);

    const tag = km.buildEktFullTag('alice');
    assert.ok(tag, 'tag should be built');

    const parsed = km.parseEktFullTag(tag);
    assert.ok(parsed, 'tag should parse');
    assert.strictEqual(parsed.ssrc, 0xDEADBEEF);
    assert.ok(km.endpointKeys.get('alice').masterKey.equals(parsed.masterKey));
});

test('KEK rotation changes kekSpi', () => {
    const km = new KeyManager();
    km.generateKek();
    assert.strictEqual(km.kekSpi, 1);

    km.rotateKek();
    assert.strictEqual(km.kekSpi, 2);
});

test('getEndpointKeyBundle includes base64 keys', () => {
    const km = new KeyManager();
    km.generateKek();
    km.generateEndpointE2eKey('bob', 9999);

    const bundle = km.getEndpointKeyBundle('bob');
    assert.ok(bundle.kek);
    assert.ok(bundle.e2eSalt);
    assert.ok(bundle.e2eMasterKey);
    assert.strictEqual(bundle.ssrc, 9999);

    // Verify base64 decodes to correct lengths
    assert.strictEqual(Buffer.from(bundle.kek, 'base64').length, 16);
    assert.strictEqual(Buffer.from(bundle.e2eSalt, 'base64').length, 12);
    assert.strictEqual(Buffer.from(bundle.e2eMasterKey, 'base64').length, 16);
});

console.log('\nConferenceManager:');

test('create conference and join', () => {
    const mgr = new ConferenceManager();
    const { keyBundle, conference } = mgr.join('room1', 'alice', [100, 101]);

    assert.strictEqual(conference.endpointCount, 1);
    assert.ok(keyBundle.kek);
    assert.ok(keyBundle.e2eMasterKey);
    assert.deepStrictEqual(keyBundle.peerKeys, {});
});

test('second endpoint gets peer keys', () => {
    const mgr = new ConferenceManager();
    mgr.join('room1', 'alice', [100]);
    const { keyBundle } = mgr.join('room1', 'bob', [200]);

    assert.ok(keyBundle.peerKeys.alice);
    assert.strictEqual(keyBundle.peerKeys.alice.ssrc, 100);
});

test('leave triggers rekey', () => {
    const mgr = new ConferenceManager();
    mgr.join('room1', 'alice', [100]);
    mgr.join('room1', 'bob', [200]);

    const result = mgr.leave('room1', 'alice');
    assert.ok(result.rekeyBundle, 'should trigger rekey');
    assert.strictEqual(result.rekeyBundle.type, 'rekey');
    assert.ok(result.rekeyBundle.allKeys.bob);
    assert.ok(!result.rekeyBundle.allKeys.alice);
});

test('last endpoint leaving removes conference', () => {
    const mgr = new ConferenceManager();
    mgr.join('room1', 'alice', [100]);

    const result = mgr.leave('room1', 'alice');
    assert.strictEqual(result.removed, true);
    assert.strictEqual(mgr.conferences.size, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
