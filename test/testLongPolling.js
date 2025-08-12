const path = require('node:path');
const axios = require('axios');
const { tests } = require('@iobroker/testing');
const { expect } = require('chai');

const PORT = 18187;
const TESTS_TIMEOUT = 45000;
process.env.NO_PROXY = '127.0.0.1';

async function createBoolean(harness, id, initial) {
    await harness.objects.setObjectAsync(id, {
        common: {
            name: 'lp-test',
            type: 'boolean',
            role: 'switch',
            def: !!initial,
        },
        native: {},
        type: 'state',
    });
    await harness.states.setStateAsync(id, !!initial);
}

async function lpConnect(port, sid, timeoutMs = 2000) {
    // Establish/refresh LP session
    await axios.get(`http://127.0.0.1:${port}/v1/polling`, {
        params: { connect: true, sid, timeout: timeoutMs },
        validateStatus: () => true,
    });
}

async function lpSubscribeState(port, sid, stateId) {
    // Subscribe with method=polling and an explicit sid (critical for per-session isolation)
    const url = `http://127.0.0.1:${port}/v1/state/${encodeURIComponent(stateId)}/subscribe`;
    const res = await axios.post(`${url}?method=polling&sid=${encodeURIComponent(sid)}`, {});
    return res.data;
}

async function lpUnsubscribeState(port, sid, stateId) {
    const url = `http://127.0.0.1:${port}/v1/state/${encodeURIComponent(stateId)}/subscribe`;
    const res = await axios.delete(`${url}?method=polling&sid=${encodeURIComponent(sid)}`, { data: {} });
    return res.data;
}

async function lpWaitEventOnce(port, sid, timeoutMs = 2000) {
    // Waits for a single LP response (event or timeout). Returns parsed object or null on timeout/empty
    const res = await axios.get(`http://127.0.0.1:${port}/v1/polling`, {
        params: { sid, timeout: timeoutMs },
        responseType: 'text',
        transformResponse: r => r, // keep raw string
        validateStatus: () => true,
    });
    const txt = (res.data || '').toString();
    if (!txt) return null;
    try {
        return JSON.parse(txt);
    } catch (e) {
        return null;
    }
}

// Run tests
tests.integration(path.join(__dirname, '..'), {
    allowedExitCodes: [11],
    loglevel: 'info',
    controllerVersion: process.env.CONTROLLER_VERSION || undefined,

    defineAdditionalTests({ suite }) {
        suite('Long-Polling: two sessions should be isolated', getHarness => {
            let harness;
            const stateId = 'javascript.0.lp-test-bool';

            before(async function () {
                this.timeout(TESTS_TIMEOUT);
                harness = getHarness();

                await harness.changeAdapterConfig(harness.adapterName, {
                    native: {
                        bind: '127.0.0.1',
                        port: PORT,
                    },
                });

                await harness.startAdapterAndWait(true);
                await createBoolean(harness, stateId, false);
            });

            it('Two LP sessions (A,B) subscribe same state; unsubscribing A must NOT break B', async function () {
                this.timeout(TESTS_TIMEOUT);

                // Open both sessions
                await lpConnect(PORT, 'A');
                await lpConnect(PORT, 'B');

                // Subscribe state for A and B with method=polling and sid in query
                await lpSubscribeState(PORT, 'A', stateId);
                await lpSubscribeState(PORT, 'B', stateId);

                // Drain one LP cycle for B so that a promise is ready
                await lpWaitEventOnce(PORT, 'B', 500); // likely returns null (timeout) which is fine

                // Unsubscribe only A
                await lpUnsubscribeState(PORT, 'A', stateId);

                // Trigger a state change
                await harness.states.setStateAsync(stateId, true);

                // Expect B to still receive the event
                // Try a few short cycles to avoid flakiness
                let received = null;
                const started = Date.now();
                while (Date.now() - started < 5000 && !received) {
                    received = await lpWaitEventOnce(PORT, 'B', 1000);
                }

                // Desired/expected behavior: B still gets the event
                // Current (buggy) behavior: likely null because adapter unsubscribed globally on A's unsubscribe
                expect(received, 'Session B should still receive state change after A unsubscribed').to.be.ok;
                expect(received).to.have.property('id', stateId);
                expect(received).to.have.property('state');
            });
        });
    },
});


