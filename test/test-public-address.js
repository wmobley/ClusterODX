const assert = require('assert');
const config = require('../config');
const {publicAddressPath} = require('../libs/netutils');
const originalAddress = config.public_address;
const originalSsl = config.use_ssl;
const request = (remoteAddress, forwarded) => ({
    headers: {host: 'cluster.example', 'x-forwarded-proto': forwarded},
    socket: {remoteAddress}
});

try {
    config.public_address = '';
    config.use_ssl = false;
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        const result = new URL(publicAddressPath('/?existing=1', request(peer, 'https'), 'a+b&c=d'));
        assert.strictEqual(result.protocol, 'https:');
        assert.strictEqual(result.searchParams.get('token'), 'a+b&c=d');
        assert.strictEqual(result.searchParams.get('existing'), '1');
    }
    for (const forwarded of ['ftp', 'https,http', '', undefined, ['https']]) {
        assert.ok(publicAddressPath('/', request('127.0.0.1', forwarded)).startsWith('http:'));
    }
    assert.ok(publicAddressPath('/', request('192.0.2.1', 'https')).startsWith('http:'));
    config.use_ssl = true;
    assert.ok(publicAddressPath('/', request('127.0.0.1', 'http')).startsWith('https:'));
    config.public_address = 'https://public.example';
    assert.strictEqual(publicAddressPath('/', request('127.0.0.1', 'http')), 'https://public.example/');
    console.log('PUBLIC ADDRESS TEST PASSED');
} finally {
    config.public_address = originalAddress;
    config.use_ssl = originalSsl;
}
