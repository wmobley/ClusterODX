const assert = require('assert');
const net = require('net');
const admincli = require('../admincli');

let occupied;
let server;

(async () => {
    await assert.rejects(
        () => admincli.create({port: 0, password: ''}),
        error => error && error.code === 'ADMIN_CLI_PASSWORD_REQUIRED'
    );

    server = await admincli.create({port: 0, password: 'test-password'});
    assert.strictEqual(server.address().address, '127.0.0.1');
    await new Promise(resolve => server.close(resolve));
    server = null;

    occupied = net.createServer();
    await new Promise((resolve, reject) => {
        occupied.once('error', reject);
        occupied.listen(0, '127.0.0.1', resolve);
    });

    await assert.rejects(
        () => admincli.create({port: occupied.address().port, password: 'test-password'}),
        error => error && error.code === 'EADDRINUSE'
    );

    console.log('ADMIN CLI PORT TEST PASSED');
})().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
}).finally(async () => {
    if (server && server.listening){
        await new Promise(resolve => server.close(resolve));
    }
    if (occupied && occupied.listening){
        await new Promise(resolve => occupied.close(resolve));
    }
});
