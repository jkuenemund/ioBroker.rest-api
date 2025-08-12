"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.subscribeStateGet = void 0;
exports.subscribeState = subscribeState;
exports.updateState = updateState;
exports.toggleState = toggleState;
exports.readState = readState;
exports.plainState = plainState;
exports.listStates = listStates;
exports.unsubscribeState = unsubscribeState;
exports.subscribeStates = subscribeStates;
exports.unsubscribeStates = unsubscribeStates;
exports.getStatesSubscribes = getStatesSubscribes;
const common_1 = require("./common");
function getIDs(oids) {
    return (oids || '')
        .toString()
        .split(',')
        .map(t => t.trim())
        .filter(t => t);
}
async function _updateState(req, res, id, timeout, val, ack) {
    if (val && typeof val !== 'object') {
        if (val === 'true' || val === 'false') {
            const obj = await req._adapter.getForeignObjectAsync(id, {
                user: req._user,
                limitToOwnerRights: req._adapter.config.onlyAllowWhenUserIsOwner,
            });
            if (obj?.common?.type === 'boolean') {
                val = val === 'true';
            }
            // @ts-expect-error fix later
        }
        else if (typeof val === 'string' && isFinite(val)) {
            try {
                const obj = await req._adapter.getForeignObjectAsync(id, {
                    user: req._user,
                    limitToOwnerRights: req._adapter.config.onlyAllowWhenUserIsOwner,
                });
                if (obj?.common?.type === 'number') {
                    val = parseFloat(val);
                }
            }
            catch (error) {
                req._adapter.log.warn(`Cannot read object ${id}: ${error.toString()}`);
                val = parseFloat(val);
            }
        }
    }
    try {
        if (!timeout) {
            if (typeof val !== 'object') {
                await req._adapter.setForeignStateAsync(id, val, !!ack, {
                    user: req._user,
                    limitToOwnerRights: req._adapter.config.onlyAllowWhenUserIsOwner,
                });
            }
            else {
                await req._adapter.setForeignStateAsync(id, val, {
                    user: req._user,
                    limitToOwnerRights: req._adapter.config.onlyAllowWhenUserIsOwner,
                });
            }
            if (typeof val === 'object') {
                res.json({ ...val, id });
            }
            else {
                res.json({ val, id });
            }
        }
        else {
            await req._adapter._addTimeout({ id, val: val, res, timeout });
            if (typeof val !== 'object') {
                await req._adapter.setForeignStateAsync(id, val, !!ack, {
                    user: req._user,
                    limitToOwnerRights: req._adapter.config.onlyAllowWhenUserIsOwner,
                });
            }
            else {
                await req._adapter.setForeignStateAsync(id, val, {
                    user: req._user,
                    limitToOwnerRights: req._adapter.config.onlyAllowWhenUserIsOwner,
                });
            }
        }
    }
    catch (error) {
        (0, common_1.errorResponse)(req, res, error, { id });
    }
}
function subscribeState(req, res) {
    (0, common_1.checkPermissions)(req._adapter, req._user, [{ type: 'state', operation: 'read' }], async (error) => {
        if (error) {
            res.status(403).json({ error: error });
        }
        else {
            const params = (0, common_1.parseUrl)(req.url, req.swagger, req._adapter.WEB_EXTENSION_PREFIX);
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            let url = body.url;
            if ((req.query && req.query.method === 'polling') || (body && body.method === 'polling')) {
                url = req.query.sid || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            }
            if (!url) {
                res.status(422).json({
                    error: 'url not provided',
                    expectedBody: { url: 'http://ipaddress:9000/hook/' },
                });
                return;
            }
            try {
                const obj = await req._adapter.getForeignObjectAsync(params.stateId, { user: req._user });
                if (!obj) {
                    res.status(404).json({ error: 'object not found', url: body.url });
                }
                else if (obj.type !== 'state') {
                    res.status(500).json({
                        error: 'Cannot subscribe on non-state',
                        stateId: params.stateId,
                        type: obj.type,
                        url: body.url,
                    });
                }
                else {
                    const error = await req._swaggerObject.registerSubscribe(url, params.stateId, 'state', req._user, {
                        method: req.query?.method || body?.method,
                        delta: req.query?.delta || body?.delta,
                        onchange: req.query?.onchange || body?.onchange,
                    });
                    if (error) {
                        (0, common_1.errorResponse)(req, res, error, { stateId: params.stateId, url: body.url });
                        return;
                    }
                    const state = await req._adapter.getForeignStateAsync(params.stateId, { user: req._user });
                    res.status(200).json(state);
                }
            }
            catch (error) {
                (0, common_1.errorResponse)(req, res, error, { stateId: params.stateId });
            }
        }
    });
}
exports.subscribeStateGet = subscribeState;
function _toggleState(req, res, oId) {
    let timeout = 0;
    if (req.query.timeout) {
        timeout = parseInt(req.query.timeout, 10);
        if (timeout > 60000) {
            timeout = 60000;
        } // maximum 1 minute
    }
    (0, common_1.findState)(req._adapter, oId, req._user, async (error, id, originId) => {
        if (error?.message?.includes('permissionError')) {
            // assume it is ID
            id = oId;
            error = null;
        }
        if (error) {
            (0, common_1.errorResponse)(req, res, error?.toString(), { id: oId });
        }
        else if (!id) {
            res.status(404).json({ error: 'ID not found', id: originId });
        }
        else {
            try {
                const state = await req._adapter.getForeignStateAsync(id, {
                    user: req._user,
                    limitToOwnerRights: req._adapter.config.onlyAllowWhenUserIsOwner,
                });
                if (!state || typeof state !== 'object') {
                    res.status(500).json({ error: 'State not initiated', id: originId });
                }
                else {
                    let obj;
                    try {
                        obj = await req._adapter.getForeignObjectAsync(id, {
                            user: req._user,
                            limitToOwnerRights: req._adapter.config.onlyAllowWhenUserIsOwner,
                        });
                    }
                    catch (error) {
                        req._adapter.log.warn(`Cannot read object ${id}: ${error}`);
                    }
                    let val;
                    if (state.val === 'true') {
                        val = 'false';
                    }
                    else if (state.val === 'false') {
                        val = 'true';
                    }
                    else if (state.val === 'on') {
                        val = 'off';
                    }
                    else if (state.val === 'off') {
                        val = 'on';
                    }
                    else if (state.val === 'OFF') {
                        val = 'ON';
                    }
                    else if (state.val === 'ON') {
                        val = 'OFF';
                    }
                    else if (state.val === '0') {
                        val = '1';
                    }
                    else if (state.val === '1') {
                        val = '0';
                    }
                    else if (typeof state.val === 'number') {
                        val = state.val ? 0 : 1;
                    }
                    else {
                        val = !state.val;
                    }
                    if (obj?.common) {
                        if (obj.common.type === 'boolean') {
                            state.val = state.val === 'true' || state.val === true;
                        }
                        else if (obj.common.type === 'number') {
                            if (obj.common.min !== undefined && obj.common.max !== undefined) {
                                val = parseFloat(state.val);
                                if (val > obj.common.max) {
                                    val = obj.common.max;
                                }
                                else if (val < obj.common.min) {
                                    val = obj.common.min;
                                }
                                val = obj.common.max + obj.common.min - val;
                            }
                            else {
                                val = parseFloat(val);
                            }
                        }
                    }
                    await _updateState(req, res, id, timeout, val);
                }
            }
            catch (error) {
                (0, common_1.errorResponse)(req, res, error, { id: oId });
            }
        }
    });
}
function updateState(req, res) {
    (0, common_1.checkPermissions)(req._adapter, req._user, [{ type: 'state', operation: 'write' }], error => {
        if (error) {
            (0, common_1.errorResponse)(req, res, error);
        }
        else {
            const params = (0, common_1.parseUrl)(req.url, req.swagger, req._adapter.WEB_EXTENSION_PREFIX);
            const oId = getIDs(params.stateId);
            let timeout = 0;
            if (req.query.timeout) {
                timeout = parseInt(req.query.timeout, 10);
                if (timeout > 60000) {
                    timeout = 60000;
                } // maximum 1 minute
            }
            (0, common_1.findState)(req._adapter, oId[0], req._user, async (error, id, originId) => {
                if (error?.message?.includes('permissionError')) {
                    // assume it is ID
                    id = oId[0];
                    error = null;
                }
                if (error) {
                    (0, common_1.errorResponse)(req, res, error?.toString(), { id: oId[0] });
                }
                else if (!id) {
                    res.status(404).json({ error: 'ID not found', id: originId });
                }
                else {
                    await _updateState(req, res, id, timeout, req.body);
                }
            });
        }
    });
}
function toggleState(req, res) {
    (0, common_1.checkPermissions)(req._adapter, req._user, [{ type: 'state', operation: 'write' }], error => {
        if (error) {
            (0, common_1.errorResponse)(req, res, error);
        }
        else {
            const params = (0, common_1.parseUrl)(req.url, req.swagger, req._adapter.WEB_EXTENSION_PREFIX);
            const oId = getIDs(params.stateId);
            _toggleState(req, res, oId[0]);
        }
    });
}
function readState(req, res) {
    (0, common_1.checkPermissions)(req._adapter, req._user, [{ type: 'state', operation: 'read' }], async (error) => {
        if (error) {
            (0, common_1.errorResponse)(req, res, error);
        }
        else {
            const params = (0, common_1.parseUrl)(req.url, req.swagger, req._adapter.WEB_EXTENSION_PREFIX);
            const oId = getIDs(params.stateId);
            let timeout = 0;
            if (req.query.timeout) {
                timeout = parseInt(req.query.timeout, 10);
                if (timeout > 60000) {
                    timeout = 60000;
                } // maximum 1 minute
            }
            let result;
            for (let k = 0; k < oId.length; k++) {
                try {
                    const { state, id, originId } = await new Promise((resolve, reject) => (0, common_1.getState)(req._adapter, oId[k], req._user, (error, state, id, originId) => error ? reject(error) : resolve({ state, id, originId })));
                    if (!id) {
                        res.status(404).json({ error: 'ID not found', id: originId });
                        return;
                    }
                    if (req.query.value !== undefined) {
                        await _updateState(req, res, id, timeout, req.query.value, req.query.ack !== undefined ? req.query.ack === 'true' : undefined);
                        return;
                    }
                    if (req.query.toggle !== undefined) {
                        _toggleState(req, res, id);
                        return;
                    }
                    const vObj = (state || {});
                    if (req.query.withInfo === 'true') {
                        try {
                            const obj = await req._adapter.getForeignObjectAsync(id);
                            // copy all attributes of the object into state
                            if (obj) {
                                Object.keys(obj).forEach(attr => {
                                    if (attr === '_id') {
                                        vObj.id = obj._id;
                                    }
                                    else {
                                        vObj[attr] = obj[attr];
                                    }
                                });
                            }
                        }
                        catch (error) {
                            req._adapter.log.warn(`Error by reading of object "${id}": ${error}`);
                        }
                    }
                    else {
                        vObj.id = id;
                    }
                    if (!result) {
                        result = vObj;
                    }
                    else {
                        if (!Array.isArray(result)) {
                            result = [result];
                        }
                        result.push(vObj);
                    }
                }
                catch (error) {
                    req._adapter.log.warn(`Cannot read ${oId.join(', ')}: ${error}`);
                    (0, common_1.errorResponse)(req, res, error, { id: oId });
                    return;
                }
            }
            res.json(result);
        }
    });
}
function plainState(req, res) {
    (0, common_1.checkPermissions)(req._adapter, req._user, [{ type: 'state', operation: 'read' }], async (error) => {
        if (error) {
            (0, common_1.errorResponse)(req, res, error);
        }
        else {
            const params = (0, common_1.parseUrl)(req.url, req.swagger, req._adapter.WEB_EXTENSION_PREFIX);
            const oId = getIDs(params.stateId);
            try {
                const { state, id, originId } = await new Promise((resolve, reject) => (0, common_1.getState)(req._adapter, oId[0], req._user, (error, state, id, originId) => error ? reject(error) : resolve({ state, id, originId })));
                if (!id) {
                    res.status(404).json({ error: 'ID not found', id: originId });
                }
                else if (!state || typeof state !== 'object') {
                    res.status(404).json({ error: 'State not found', id: originId });
                }
                else {
                    if (req.query.extraPlain === 'true') {
                        if (state.val === null) {
                            res.send('null');
                        }
                        else if (state.val === undefined) {
                            res.send('undefined');
                        }
                        else {
                            res.send(state.val.toString());
                        }
                    }
                    else {
                        res.send(JSON.stringify(state.val));
                    }
                }
            }
            catch (error) {
                (0, common_1.errorResponse)(req, res, error, { id: oId });
            }
        }
    });
}
function listStates(req, res) {
    (0, common_1.checkPermissions)(req._adapter, req._user, [{ type: 'state', operation: 'list' }], error => {
        if (error) {
            (0, common_1.errorResponse)(req, res, error);
        }
        else {
            req._adapter.getForeignStates(req.query.filter || '*', {
                user: req._user,
                limitToOwnerRights: req._adapter.config.onlyAllowWhenUserIsOwner,
            }, (error, list) => {
                if (error) {
                    (0, common_1.errorResponse)(req, res, error?.toString(), { filter: req.query.filter });
                }
                else {
                    res.json(list || []);
                }
            });
        }
    });
}
function unsubscribeState(req, res) {
    (0, common_1.checkPermissions)(req._adapter, req._user, [{ type: 'state', operation: 'read' }], async (error) => {
        if (error) {
            (0, common_1.errorResponse)(req, res, error);
        }
        else {
            const params = (0, common_1.parseUrl)(req.url, req.swagger, req._adapter.WEB_EXTENSION_PREFIX);
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            let url = body.url;
            if (req.query?.method === 'polling' || body?.method === 'polling') {
                url = req.query.sid || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            }
            if (!url) {
                res.status(422).json({
                    error: 'url not provided',
                    expectedBody: { url: 'http://ipaddress:9000/hook/' },
                });
                return;
            }
            try {
                await req._swaggerObject.unregisterSubscribe(url, params.stateId, 'state', req._user);
                res.status(200).json({ result: 'OK' });
            }
            catch (error) {
                (0, common_1.errorResponse)(req, res, error, { stateId: params.stateId });
            }
        }
    });
}
function subscribeStates(req, res) {
    (0, common_1.checkPermissions)(req._adapter, req._user, [{ type: 'state', operation: 'read' }], async (error) => {
        if (error) {
            (0, common_1.errorResponse)(req, res, error);
        }
        else {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            let url = body.url;
            if ((req.query && req.query.method === 'polling') || (body && body.method === 'polling')) {
                url = req.query.sid || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            }
            if (!url) {
                res.status(422).json({
                    error: 'url not provided',
                    expectedBody: { url: 'http://ipaddress:9000/hook/' },
                });
                return;
            }
            if (!body.pattern) {
                res.status(422).json({
                    error: 'pattern not provided',
                    expectedBody: { url: 'http://ipaddress:9000/hook/', pattern: 'system.adapter.admin.0.*' },
                });
                return;
            }
            try {
                await req._swaggerObject.registerSubscribe(url, body.pattern, 'state', req._user, {
                    method: body.method,
                    onchange: body.onchange === 'true' || body.onchange === true,
                    delta: body.delta !== undefined ? parseFloat(body.delta) : undefined,
                });
            }
            catch (error) {
                (0, common_1.errorResponse)(req, res, error, { pattern: body.pattern, url: body.url });
            }
        }
    });
}
function unsubscribeStates(req, res) {
    (0, common_1.checkPermissions)(req._adapter, req._user, [{ type: 'state', operation: 'read' }], async (error) => {
        if (error) {
            (0, common_1.errorResponse)(req, res, error);
        }
        else {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            let url = body.url;
            if (body.method === 'polling') {
                url = req.query.sid || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            }
            if (!url) {
                res.status(422).json({
                    error: 'url not provided',
                    expectedBody: { url: 'http://ipaddress:9000/hook/' },
                });
                return;
            }
            try {
                await req._swaggerObject.unregisterSubscribe(url, body.pattern, 'state', req._user);
                res.status(200).json({ result: 'OK' });
            }
            catch (error) {
                (0, common_1.errorResponse)(req, res, error, { pattern: body.pattern, url: body.url });
            }
        }
    });
}
function getStatesSubscribes(req, res) {
    (0, common_1.checkPermissions)(req._adapter, req._user, [{ type: 'state', operation: 'read' }], error => {
        if (error) {
            (0, common_1.errorResponse)(req, res, error);
        }
        else {
            const body = req.body && typeof req.body === 'object' ? req.body : {};
            let url = body.url;
            if ((req.query && req.query.method === 'polling') || (body && body.method === 'polling')) {
                url = req.query.sid || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            }
            if (!url) {
                res.status(422).json({
                    error: 'url not provided',
                    expectedBody: { url: 'http://ipaddress:9000/hook/' },
                });
                return;
            }
            try {
                const result = req._swaggerObject.getSubscribes(url, body.pattern, 'state');
                if (result === null) {
                    res.status(404).json({ error: 'URL or session not found' });
                    return;
                }
                res.json({ states: result });
            }
            catch (error) {
                (0, common_1.errorResponse)(req, res, error, { pattern: body.pattern, url: body.url });
            }
        }
    });
}
//# sourceMappingURL=state.js.map