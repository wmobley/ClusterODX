'use strict';
// Holds the running SplatTasks service so the admin web webhook can reach it without
// importing the proxy (and its native dependencies). Set once by libs/proxy.js.
module.exports = {instance: null};
