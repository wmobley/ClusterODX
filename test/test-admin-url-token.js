const assert = require('assert');

(async () => {
    const { consumeHashToken, extractHashToken } = await import('../public/authToken.mjs');

    assert.strictEqual(extractHashToken(''), '');
    assert.strictEqual(extractHashToken('#view=nodes'), '');
    assert.strictEqual(extractHashToken('#token=  jwt-token  '), 'jwt-token');
    assert.strictEqual(extractHashToken('token=jwt-token'), 'jwt-token');

    const historyCalls = [];
    const windowObject = {
        location: {
            hash: '#token=jwt-token',
            pathname: '/admin/',
            search: '?view=nodes',
        },
        document: { title: 'ClusterODX' },
        history: {
            replaceState: (...args) => historyCalls.push(args),
        },
    };

    assert.strictEqual(consumeHashToken(windowObject), 'jwt-token');
    assert.deepStrictEqual(historyCalls, [[null, 'ClusterODX', '/admin/?view=nodes']]);

    windowObject.location.hash = '#view=nodes';
    assert.strictEqual(consumeHashToken(windowObject), '');
    assert.strictEqual(historyCalls.length, 1);

    console.log('ADMIN URL TOKEN TEST PASSED');
})().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
