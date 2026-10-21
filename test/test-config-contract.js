const assert = require('assert');
const config = require('../config');

assert.strictEqual(typeof config.node_shared_path_mappings, 'object');
assert.ok(config.node_shared_path_mappings['*']);
assert.strictEqual(config.tmp_dir, 'tmp');
assert.strictEqual(config.webodm.requireStaff, true);
assert.strictEqual(config.registration_secret, '');
assert.deepStrictEqual(config.admin_web_allowed_tenants, []);
assert.deepStrictEqual(config.admin_web_allowed_users, []);

console.log('CONFIG CONTRACT TEST PASSED');
