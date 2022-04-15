/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
/* jshint -W061 */
'use strict';

const SwaggerRunner = require('swagger-node-runner-fork');
const swaggerUi      = require('swagger-ui-express');
const YAML           = require('yamljs');
const bodyParser     = require('body-parser');
const crypto         = require('crypto');
const axios          = require('axios');
const cors           = require('cors');
const fs             = require('fs');

process.env.SUPPRESS_NO_CONFIG_WARNING = 'true';

function parseQuery(_url) {
    let url = decodeURI(_url);
    const pos = url.indexOf('?');
    const values = [];
    if (pos !== -1) {
        const arr = url.substring(pos + 1).split('&');
        url = url.substring(0, pos);

        for (let i = 0; i < arr.length; i++) {
            arr[i] = arr[i].split('=');
            values[arr[i][0].trim()] = arr[i][1] === undefined ? null : decodeURIComponent((arr[i][1] + '').replace(/\+/g, '%20'));
        }

        // Default value for wait
        if (values.timeout === null) {
            values.timeout = 2000;
        }
    }

    const parts = url.split('/');

    // Analyse system.adapter.socketio.0.uptime,system.adapter.history.0.memRss?value=78&timeout=300
    if (parts[2]) {
        const oId = parts[2].split(',');
        for (let j = oId.length - 1; j >= 0; j--) {
            oId[j] = oId[j].trim();
            if (!oId[j]) {
                oId.splice(j, 1);
            }
        }
    }

    return values;
}

/**
 * SwaggerUI class
 *
 * From settings used only secure, auth and crossDomain
 *
 * @class
 * @param {object} server http or https node.js object
 * @param {object} webSettings settings of the web server, like <pre><code>{secure: settings.secure, port: settings.port}</code></pre>
 * @param {object} adapter web adapter object
 * @param {object} instanceSettings instance object with common and native
 * @param {object} app express application
 * @param {function} callback called when the engine is initialized
 * @return {object} object instance
 */
function SwaggerUI(server, webSettings, adapter, instanceSettings, app, callback) {
    if (!(this instanceof SwaggerUI)) {
        return new SwaggerUI(server, webSettings, adapter, instanceSettings, app, callback);
    }

    if (typeof instanceSettings === 'function') {
        callback = instanceSettings;
        instanceSettings = null;
    }

    this.server     = server;
    this.app        = app || require('express')();
    this.adapter    = adapter;
    this.settings   = webSettings;
    this.config     = instanceSettings ? instanceSettings.native : {};
    this.namespace  = instanceSettings ? instanceSettings._id.substring('system.adapter.'.length) : 'swagger';
    this.subscribes = {};
    this.checkInterval = null;
    this.extension  = !!instanceSettings;
    this.routerPrefix = this.extension ? '/swagger/' : '/';
    this.gcInterval = null;

    this.adapter.config.defaultUser = this.extension ? this.config.defaultUser : this.adapter.config.defaultUser || 'system.user.admin';

    this.adapter.config.checkInterval = this.adapter.config.checkInterval === undefined ? 20000 : parseInt(this.adapter.config.checkInterval, 10);
    if (this.adapter.config.checkInterval && this.adapter.config.checkInterval < 5000) {
        this.adapter.config.checkInterval = 5000;
    }

    this.adapter.config.hookTimeout = parseInt(this.adapter.config.hookTimeout, 10) || 3000;
    if (this.adapter.config.hookTimeout && this.adapter.config.hookTimeout < 50) {
        this.adapter.config.hookTimeout = 50;
    }

    if (this.adapter.config.onlyAllowWhenUserIsOwner === undefined) {
        this.adapter.config.onlyAllowWhenUserIsOwner = false;
    }

    if (!this.adapter.config.defaultUser.match(/^system\.user\./)) {
        this.adapter.config.defaultUser = 'system.user.' + this.adapter.config.defaultUser;
    }

    let swaggerDocument = YAML.load(__dirname + '/api/swagger/swagger.yaml');
    if (this.extension) {
        swaggerDocument.basePath = '/rest/v1';
    }
    const that = this;

    // enable cors only if standalone
    !instanceSettings && this.app.use(cors());
    this.app.use(bodyParser.json());
    if (!this.adapter.config.noUI) {
        this.app.get(this.routerPrefix + 'api-docs/swagger.json', (req, res) =>
            res.json(swaggerDocument));
        // show WEB CSS and so on
        this.app.use(this.routerPrefix + 'api-doc/', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
        this.app.get(this.routerPrefix, (req, res) =>
            res.redirect(this.routerPrefix + 'api-doc/'));
    }

    function isAuthenticated(req, res, callback) {
        if (that.adapter.config.auth) {
            let values = parseQuery(req.url);
            if (!values.user || !values.pass) {
                if (req.headers.authorization && req.headers.authorization.startsWith('Basic ')) {
                    const auth = Buffer.from(req.headers.authorization.substring(6), 'base64').toString('utf8');
                    const pos = auth.indexOf(':');
                    if (pos !== -1) {
                        values = {
                            user: auth.substring(0, pos),
                            pass: auth.substring(pos + 1)
                        };
                    }
                }
                if (!values.user || !values.pass) {
                    res.status(401).send({error: 'User is required'});
                    return;
                }
            }
            if (!values.user.match(/^system\.user\./)) {
                values.user = 'system.user.' + values.user;
            }

            that.adapter.checkPassword(values.user, values.pass, result => {
                if (result) {
                    req._user = values.user;
                    that.adapter.log.debug(`Logged in: ${values.user}`);
                    callback(true);
                } else {
                    callback = null;
                    that.adapter.log.warn(`Invalid password or user name: ${values.user}`);
                    res.status(401).send({error: `Invalid password or user name: ${values.user}`});
                }
            });
        } else if (callback) {
            req._user = that.adapter.config.defaultUser;
            callback();
        }
    }

    async function _validateUrlHook(item) {
        try {
            await axios.post(item.urlHook, {test: true}, {
                timeout: that.adapter.config.hookTimeout,
                validateStatus: status => status < 400
            });
        } catch (error) {
            if (error.response) {
                that.adapter.log.warn(`Cannot report to hook "${item.urlHook}": ${error.response.data || error.response.status}`);
            } else {
                that.adapter.log.warn(`Cannot report to hook "${item.urlHook}": ${JSON.stringify(error)}`);
            }
            item.errors = item.errors || 0;
            item.errors++;
            if (item.errors > 2) {
                that.adapter.log.warn(`3 errors by "${item.urlHook}": all subscriptions removed`);
                await that.unregisterSubscribe(item.urlHook, null, 'state');
                await that.unregisterSubscribe(item.urlHook, null, 'object');
            }

            return 'Cannot validate URL';
        }
    }

    async function reportChange(item, data) {
        if (item.polling) {
            if (item.promise) {
                item.promise.resolve(JSON.stringify(data));
            } else {
                item.queue = item.queue || [];
                const now = Date.now();
                item.queue.push({data: JSON.stringify(data), ts: now});

                // delete too old entries
                for (let d = item.queue.length - 1; d >= 0; d--) {
                    if (now - item.queue[d].ts > 3000) {
                        const urlHash = crypto.createHash('md5').update(item.urlHook).digest('hex');
                        that.adapter.log.debug(`[${item.urlHook}] Data update skipped, as no handler (${d + 1})`);
                        item.queue.splice(0, d);
                        break;
                    }
                }
            }
        } else {
            try {
                await axios.post(item.urlHook, data, {
                    timeout: that.adapter.config.hookTimeout,
                    validateStatus: status => status < 400
                });
            } catch (error) {
                if (error.response) {
                    that.adapter.log.warn(`Cannot report to hook "${item.urlHook}": ${error.response.data || error.response.status}`);
                } else {
                    that.adapter.log.warn(`Cannot report to hook "${item.urlHook}": ${JSON.stringify(error)}`);
                }
                item.errors = item.errors || 0;
                item.errors++;
                if (item.errors > 2) {
                    that.adapter.log.warn(`3 errors by "${item.urlHook}": all subscriptions removed`);
                    await that.unregisterSubscribe(item.urlHook, null, 'state');
                    await that.unregisterSubscribe(item.urlHook, null, 'object');
                }
            }
        }
    }

    this._checkHooks = async () => {
        const hooks = Object.keys(this.subscribes);
        for (let i = 0; i < hooks.length; i++) {
            if (!this.subscribes[hooks[i]].polling) {
                await _validateUrlHook(this.subscribes[hooks[i]]);
            }
        }
    }

    this._executeGC = () => {
        const hashes = Object.keys(this.subscribes)
            .filter(urlHash => this.subscribes[urlHash].polling);

        if (!hashes.length) {
            clearInterval(this.gcInterval);
            this.gcInterval = null;
        } else {
            const now = Date.now();
            hashes.forEach(async urlHash => {
                // kill all subscriptions after 2 minutes
                if (now - this.subscribes[urlHash].ts > this.subscribes[urlHash].timeout * 2) {
                    if (this.subscribes[urlHash].promise) {
                        debugger;
                        // this should never happen
                        this.subscribes[urlHash].promise.resolve();
                    }
                    // unsubscribe
                    for (let i = 0; i < this.subscribes[urlHash].state.length; i++) {
                        this.adapter.log.debug(`[${this.subscribes[urlHash].urlHook}] unsubscribe from state: ${this.subscribes[urlHash].state[i].id}`);
                        await this.adapter.unsubscribeForeignStatesAsync(this.subscribes[urlHash].state[i].id);
                    }
                    for (let i = 0; i < this.subscribes[urlHash].object.length; i++) {
                        this.adapter.log.debug(`[${this.subscribes[urlHash].urlHook}] unsubscribe from object: ${this.subscribes[urlHash].object[i].id}`);
                        await this.adapter.unsubscribeForeignObjectsAsync(this.subscribes[urlHash].object[i].id);
                    }

                    this.adapter.log.debug(`[${this.subscribes[urlHash].urlHook}] Destroy connection due inactivity`);

                    delete this.subscribes[urlHash];
                }
            });
        }
    };

    this.startGC = () => {
        this.gcInterval = this.gcInterval || setInterval(() => this._executeGC(), 30000);
    }

    this.registerSubscribe = async (urlHook, id, type, user, method) => {
        const urlHash = crypto.createHash('md5').update(urlHook).digest('hex');
        if (!this.subscribes[urlHash]) {
            if (method !== 'polling') {
                const error = await _validateUrlHook({urlHook});
                if (error) {
                    return `No valid answer from URL hook: ${error}`;
                }
            }
            if (method === 'polling') {
                this.adapter.log.debug(`[${urlHook}] Subscribe on connection`);
                this.startGC();
            }

            this.subscribes[urlHash] = {state: [], object: [], urlHook, polling: method === 'polling', ts: Date.now()};
        }
        if (!this.subscribes[urlHash][type].find(item => item.id === id && (!item.method || item.method === method))) {
            this.subscribes[urlHash][type].push({id});
            if (type === 'state') {
                this.adapter.log.debug(`[${urlHook}] Subscribe on state "${id}"`);
                await this.adapter.subscribeForeignStatesAsync(id, {user});
            } else {
                this.adapter.log.debug(`[${urlHook}] Subscribe on object "${id}"`);
                await this.adapter.subscribeForeignObjectsAsync(id, {user});
            }
        }

        if (this.adapter.config.checkInterval) {
            if (this.checkInterval) {
                this.adapter.log.debug(`start checker`);
                this.checkInterval = setInterval(async () => await this._checkHooks(), this.adapter.config.checkInterval);
            }
        } else {
            this.adapter.log.warn('No check interval set! The connections are valid forever.');
        }

        return null; // success
    };

    this.unregisterSubscribe = async (urlHook, id, type, user, method) => {
        const urlHash = crypto.createHash('md5').update(urlHook).digest('hex');
        if (this.subscribes[urlHash]) {
            if (id) {
                let pos;
                do {
                    pos = this.subscribes[urlHash][type].findIndex(item => item.id === id);
                    if (pos !== -1) {
                        this.subscribes[urlHash][type].splice(pos, 1);
                        if (type === 'state') {
                            this.adapter.log.debug(`Unsubscribe from state "${id}"`);
                            await this.adapter.unsubscribeForeignStatesAsync(id, {user: user || 'system.user.admin'}); // allow unsubscribing always
                        } else {
                            this.adapter.log.debug(`Unsubscribe from object "${id}"`);
                            await this.adapter.unsubscribeForeignObjectsAsync(id, {user: user || 'system.user.admin'}); // allow unsubscribing always
                        }
                    } else {
                        break;
                    }
                } while (pos !== -1)
            } else {
                for (let i = 0; i < this.subscribes[urlHash][type].length; i++) {
                    if (type === 'state') {
                        await this.adapter.unsubscribeForeignStatesAsync(this.subscribes[urlHash][type][i].id, {user: user || 'system.user.admin'}); // allow unsubscribing always
                    } else {
                        await this.adapter.unsubscribeForeignObjectsAsync(this.subscribes[urlHash][type][i].id, {user: user || 'system.user.admin'}); // allow unsubscribing always
                    }
                }
                this.subscribes[urlHash][type] = [];
            }

            if (!this.subscribes[urlHash].state.length && !this.subscribes[urlHash].object.length) {
                delete this.subscribes[urlHash];

                if (!Object.keys(this.subscribes).length) {
                    this.adapter.log.debug(`Stop checker`);
                    this.checkInterval && clearInterval(this.checkInterval);
                    this.checkInterval = null;
                }
            }
        }

        return null; // success
    };

    this.stateChange = (id, state) => {
        if (state && state.ack) {
            for (let t = this._waitFor.length - 1; t >= 0; t++) {
                if (this._waitFor[t].id === id) {
                    const task = this._waitFor[t];
                    this._waitFor.splice(t, 1);
                    if (!Object.keys(this.subscribes).find(item => item.states.includes(id))) {
                        this.adapter.unsubscribeForeignStates(id);
                    }

                    clearTimeout(task.timer);

                    setImmediate((_task, _val) => {
                        state.id = id;
                        _task.res.json(state);
                    }, task, state);
                }
            }
        }

        Object.keys(this.subscribes).forEach(urlHash => {
            this.subscribes[urlHash].state.forEach(async item => {
                // check if id
                if (typeof item.id === 'string') {
                    await reportChange(this.subscribes[urlHash], {id: item.id, state});
                } else {
                    // todo
                }
            });
        });
    };

    this.objectChange = (id, obj) => {
        Object.keys(this.subscribes).forEach(urlHash => {
            this.subscribes[urlHash].object.forEach(async item => {
                // check if id
                if (typeof item.id === 'string') {
                    await reportChange(this.subscribes[urlHash].urlHook, {id: item.id, obj});
                } else {
                    // todo
                }
            });
        });
    };

    // wait for ack=true
    this._waitFor = [];
    this.adapter._addTimeout = async task => {
        this._waitFor.push(task);

        // if not already subscribed
        if (!Object.keys(this.subscribes).find(item => item.states.includes(task.id))) {
            await this.adapter.subscribeForeignStates(task.id);
        }

        task.timer = setTimeout(_task => {
            // remove this task from list
            const pos = this._waitFor.indexOf(_task);
            if (pos !== -1) {
                this._waitFor.splice(pos, 1);
            }

            if (!Object.keys(this.subscribes).find(item => item.states.includes(task.id))) {
                this.adapter.unsubscribeForeignStates(task.id);
            }
            _task.res.status(501).json({error: 'timeout', id: _task.id, val: _task.val});
            _task = null;
        }, task.timeout, task);
    };

    // authenticate
    this.app.use(this.routerPrefix + 'v1/*', (req, res, next) => {
        isAuthenticated(req, res, () => {
            req._adapter = this.adapter;
            req._swaggerObject = this;
            next();
        });
    });

    this.app.get(this.routerPrefix + 'v1/polling', (req, res, next) => {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        if (req.query.sid) {
            ip += '_' + req.query.sid;
        }
        const urlHash = crypto.createHash('md5').update(ip).digest('hex');

        let item = this.subscribes[urlHash];

        this.startGC();

        if (req.query.check === 'true') {
            if (!item) {
                this.adapter.log.debug(`[${ip}] Initiate connection`);
                this.subscribes[urlHash] = {state: [], object: [], urlHook: ip, polling: true, timeout: parseInt(req.query.timeout, 10) || 30000, ts: Date.now()};
                item = this.subscribes[urlHash];
            } else if (req.query.timeout) {
                item.timeout = parseInt(req.query.timeout, 10);
            }
            if (item.timeout < 1000) {
                item.timeout = 1000;
            } else
            if (item.timeout > 60000) {
                item.timeout = 60000;
            }
            return res.end('_');
        } else if (!item) {
            this.subscribes[urlHash] = {state: [], object: [], urlHook: ip, polling: true, timeout: parseInt(req.query.timeout, 10) || 30000, ts: Date.now()};
            item = this.subscribes[urlHash];
        } else {
            item.ts = Date.now();
        }

        // If some data wait to be sent
        if (item.queue && item.queue.length) {
            // delete too old entries
            const now = Date.now();
            for (let d = item.queue.length - 1; d >= 0; d--) {
                if (now - item.queue[d].ts > 3000) {
                    that.adapter.log.debug(`[${item.urlHook}] Data update  was too old and ignored`);
                    item.queue.splice(0, d);
                    break;
                }
            }
            if (item.queue.length) {
                const chunk = item.queue.shift();
                res.end(chunk.data);
                return;
            }
        }

        new Promise(resolve => {
            item.promise = {
                resolve,
                ts: setTimeout(() => {
                    item.promise.ts = null;
                    resolve();
                }, item ? item.timeout : 30000)};
        })
            .then(data => {
                if (item.promise) {
                    item.promise.ts && clearTimeout(item.promise.ts);
                    item.promise.ts = null;
                    item.promise.resolve = null;
                    item.promise = null;
                } else {
                    debugger;
                }
                res.end(data);
            });

        req.on('error', error => {
            if (!error.message.includes('aborted')) {
                this.adapter.log.warn(`[${item && item.urlHook}]Error in polling connection: ${error}`);
            }
            if (item.promise) {
                item.promise.ts && clearTimeout(item.promise.ts);
                item.promise.ts = null;
                item.promise.resolve = null;
                item.promise = null;
            }
        });
    });

    this.unload = async () => {
        this.checkInterval && clearInterval(this.checkInterval);
        this.checkInterval = null;
        this.gcInterval && clearInterval(this.gcInterval);
        this.gcInterval = null;
        // send to all hooks, disconnect event

        const hooks = Object.keys(this.subscribes);
        for (let h = 0; h < hooks.length; h++) {
            await reportChange(this.subscribes[hooks[h]], {disconnect: true});
        }
        this.subscribes = {};
    }

    // deliver to web the link to Web interface
    this.welcomePage = () => {
        return {
            link: 'rest/',
            name: 'REST-API',
            img: 'adapter/rest-api/rest-api.png',
            color: '#157c00',
            order: 10,
            pro: false
        };
    }

    // Say to web instance to wait till this instance is initialized
    this.waitForReady = cb => {
        callback = cb;
    }

    const _options = {
        appRoot: __dirname,
    };

    // create swagger.yaml copy with changed basePath
    if (this.extension) {
        _options.swaggerFile = __dirname + '/api/swagger/swagger_extension.yaml';

        let file = fs.readFileSync(__dirname + '/api/swagger/swagger.yaml').toString('utf8')
        file = file.replace('basePath: "/v1"', 'basePath: "/rest/v1"');
        if (!fs.existsSync(_options.swaggerFile) || fs.readFileSync(_options.swaggerFile).toString('utf8') !== file) {
            fs.writeFileSync(_options.swaggerFile, file);
        }
    }

    // read default history
    if (!this.adapter.config.dataSource) {
        this.adapter.getForeignObjectAsync('system.config')
            .then(obj => {
                if (obj && obj.common && obj.common.defaultHistory) {
                    this.adapter.config.dataSource = obj.common.defaultHistory;
                }
            });
    }

    SwaggerRunner.create(_options, (err, swaggerRunner) => {
        if (err) {
            throw err;
        }

        this.swagger = swaggerRunner;

        // install middleware
        swaggerRunner.expressMiddleware().register(this.app);

        callback && callback(this.app);
    });
}

module.exports = SwaggerUI;