const assert = require('assert');
const {
    extractBearerToken,
    normalizeRegistration,
    translateImportPathForNode
} = require('../libs/tapisRegistration');

assert.strictEqual(extractBearerToken({ authorization: 'Bearer example-token' }), 'example-token');
assert.strictEqual(extractBearerToken({ authorization: 'Basic abc' }), null);

const registration = normalizeRegistration({ hostname: 'worker-1', port: '3000', token: 'node-token' });
assert.strictEqual(registration.hostname, 'worker-1');
assert.strictEqual(registration.port, 3000);
assert.strictEqual(registration.nodeToken, 'node-token');

assert.throws(() => normalizeRegistration({ hostname: 'worker/1', port: 3000 }), /Invalid hostname/);
assert.throws(() => normalizeRegistration({ hostname: 'worker-1', port: 70000 }), /Invalid port/);

assert.strictEqual(
    translateImportPathForNode('/corral/webodm/media/project/images', 'worker-1'),
    '/corral/utexas/BCS26030/webodm/media/project/images'
);
assert.strictEqual(
    translateImportPathForNode('/corral/webodm/media2/project', 'worker-1'),
    '/corral/webodm/media2/project'
);

console.log('TAPIS REGISTRATION TEST PASSED');
