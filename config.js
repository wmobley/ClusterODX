/**
 *  ClusterODX - A reverse proxy, load balancer and task tracker for NodeODX
 *  Copyright (C) 2018-present WebODM Contributors
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU Affero General Public License as
 *  published by the Free Software Foundation, either version 3 of the
 *  License, or (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU Affero General Public License for more details.
 *
 *  You should have received a copy of the GNU Affero General Public License
 *  along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
'use strict';

const fs = require('fs');

// Read configuration from file
let defaultConfigFilePath = "config-default.json";
let defaultConfig = {};
try{
    let data = fs.readFileSync(defaultConfigFilePath);
    defaultConfig = JSON.parse(data.toString());
    defaultConfig.config = defaultConfigFilePath;
}catch(e){
    console.warn(`config-default.json not found or invalid: ${e.message}`);
    process.exit(1);
}

let argDefs = {
    string: ['port', 'admin-cli-port', 'admin-pass', 'admin-web-port',
            'cloud-provider', 'downloads-from-s3', 'token', 'log-level',
            'upload-max-speed', 'ssl-key', 'ssl-cert', 'secure-port',
            'public-address', 'config', 'admin-session-secret',
            'asr', 'registration-secret', 'webodm-base-url',
            'admin-web-allowed-tenants', 'admin-web-allowed-users', 'tmp-dir'],
    boolean: ['splitmerge', 'debug', 'allow-local-download-bypass',
              'force-node-downloads', 'webodm-require-staff', 'admin-web-use-tapis-jwt'],
    alias: {
        p: 'port',
        c: 'cloud-provider'
    },
    default: defaultConfig,

    int: ['port', 'admin-cli-port', 'admin-web-port', 
          'secure-port', 'upload-max-speed', 'flood-limit', 'stale-uploads-timeout',
          'webodm-timeout-ms'] // for cast only, not used by minimist
};
let argv = require('minimist')(process.argv.slice(2), argDefs);

if (argv.help){
	console.log(`
Usage: node index.js [options]

Options:
    --config <path>	Path to JSON configuration file. You can use a configuration file instead of passing command line parameters. (default: config-default.json)
    -p, --port <number>	Port to bind the server to (default: 3000)
    --secure-port <number>	If SSL is enabled and you want to expose both a secure and non-secure service, set this value to the secure port. Otherwise only SSL will be enabled using the --port value. (default: none)
    --admin-cli-port <number> 	Port to bind the admin CLI to. Set to zero to disable. (default: 8080)
    --admin-web-port <number> 	Port to bind the admin web interface to. Set to zero to disable. (default: 10000)
    --admin-pass <string> 	Password for the admin CLI and optional Basic Auth web mode (default: none)
    --admin-web-use-tapis-jwt <boolean> 	Authenticate the admin web interface with Tapis JWTs (default: true)
    --admin-web-allowed-tenants <string> 	Comma-separated Tapis tenants allowed in JWT web mode (default: none)
    --admin-web-allowed-users <string> 	Comma-separated Tapis usernames allowed in JWT web mode (default: none)
    --log-level <logLevel>	Set log level verbosity (default: info)
    -c, --cloud-provider	Cloud provider to use (default: local)
    --upload-max-speed <number>	Upload to processing nodes speed limit in bytes / second (default: no limit)
    --downloads-from-s3 <URL>	Manually set the S3 URL prefix where to redirect /task/<uuid>/download requests. (default: do not use S3, forward download requests to nodes, unless the autoscaler is setup, in which case the autoscaler's S3 configuration is used) 
    --no-splitmerge	By default the program will set itself as being a cluster node for all split/merge tasks. Setting this option disables it. (default: false)
    --public-address <http(s)://host:port>	Should be set to a public URL that nodes can use to reach ClusterODX. (default: match the "host" header from client's HTTP request)
    --flood-limit <number>	Limit the number of simultaneous task uploads that a user can initiate concurrently (default: no limit)
    --stale-uploads-timeout <number>	Delete temporary uploads if no activity is recorded for these many hours. After 48 hours stale uploads are always removed regardless of this option. (default: do not remove stale uploads)
    --token <token> Sets a token that needs to be passed for every request. This can be used to limit access to the node only to token holders. (default: none)
    --debug 	Disable caches and other settings to facilitate debug (default: false)
    --ssl-key <file>	Path to .pem SSL key file
    --ssl-cert <file>	Path to SSL .pem certificate
    --asr <file>	Path to configuration for enabling the autoscaler. This is combined with the provider's default configuration (default: none)
    --access-log <file>	Path where to store access log file (default: none)
    
Log Levels: 
error | debug | info | verbose | debug | silly 
`);
	process.exit(0);
}

let userConfig = {};
if (argv.config !== defaultConfigFilePath){
    try{
        userConfig = JSON.parse(fs.readFileSync(argv.config).toString());
    }catch(e){
        console.warn(`${argv.config} not found or invalid: ${e.message}`);
        process.exit(1);
    }
}

const castValue = (value, cast) => {
    if (value === undefined) return undefined;
    if (cast === String) {
        if (typeof value === 'string' || value === null) return value === null ? '' : value;
        // Preserve structured settings such as node_shared_path_mappings.
        return value;
    }
    return cast(value);
};

function readConfig(key, cast = String){
    // Keep the admin password out of command lines and configuration files
    // when desired. The restart helper passes this through the environment.
    if (key === 'admin-pass' && process.env.CLUSTERODX_ADMIN_PASS){
        return castValue(process.env.CLUSTERODX_ADMIN_PASS, cast);
    }
    if (userConfig[key] !== undefined) return castValue(userConfig[key], cast);
    if (argv[key] !== undefined) return castValue(argv[key], cast);
    return '';
}

let config = {};

// Logging configuration
config.logger = {};
config.logger.level = readConfig('log-level'); // What level to log at; info, verbose or debug are most useful. Levels are (npm defaults): silly, debug, verbose, info, warn, error.
config.logger.maxFileSize = 1024 * 1024 * 100; // Max file size in bytes of each log file; default 100MB
config.logger.maxFiles = 10; // Max number of log files kept
config.logger.logDirectory = '' // Set this to a full path to a directory - if not set logs will be written to the application directory.

config.accessLog = {};
config.accessLog.maxFileSize = 1024 * 1024 * 100;
config.accessLog.logFile = readConfig("access-log");

for (let k in argv){
    if (k === '_' || k.length === 1) continue;
    let ck = k.replace(/-/g, "_");
    let cast = String;
    if (argDefs.int.indexOf(k) !== -1) cast = parseInt;
    if (argDefs.boolean.indexOf(k) !== -1) cast = Boolean;
    config[ck] = readConfig(k, cast);
}

const mergeWebodmConfig = () => {
    const defaults = defaultConfig.webodm || {};
    const overrides = userConfig.webodm || {};
    const merged = Object.assign({}, defaults, overrides);
    if (process.argv.includes('--webodm-base-url') && argv['webodm-base-url']) {
        merged.baseUrl = argv['webodm-base-url'];
    }
    if (process.argv.includes('--webodm-require-staff') || process.argv.includes('--no-webodm-require-staff')){
        merged.requireStaff = Boolean(argv['webodm-require-staff']);
    }
    if (process.argv.includes('--webodm-timeout-ms') && argv['webodm-timeout-ms']){
        merged.timeoutMs = parseInt(argv['webodm-timeout-ms'], 10);
    }
    return merged;
};

config.webodm = mergeWebodmConfig();

if (!config.tmp_dir || config.tmp_dir.length === 0) config.tmp_dir = 'tmp';

const parseList = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value === 'string') return value.split(',').map(entry => entry.trim()).filter(Boolean);
    return [];
};

config.admin_web_allowed_tenants = parseList(config.admin_web_allowed_tenants);
config.admin_web_allowed_users = parseList(config.admin_web_allowed_users);
config.admin_web_use_tapis_jwt = Boolean(config.admin_web_use_tapis_jwt);

config.use_ssl = config.ssl_key && config.ssl_cert;
if (config.debug) config.logger.level = 'debug';

module.exports = config;
