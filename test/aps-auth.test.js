const test = require('node:test');
const assert = require('node:assert/strict');
const { createApsAuth } = require('../lib/aps-auth');

function createRequest(session, sessionID) {

    return {
        app : {
            locals : {
                clientId : 'test-client-id',
                tenant   : 'test-tenant'
            }
        },
        session,
        sessionID
    };

}

function runMiddleware(middleware, req) {

    return new Promise(function(resolve, reject) {
        let response = {
            status : function(status) {
                this.statusCode = status;
                return this;
            },
            json : function(body) {
                reject(new Error('Middleware returned ' + this.statusCode + ': ' + body.message));
            }
        };

        middleware(req, response, resolve);
    });

}

test('stores access token, refresh token and absolute expiration in the session', function() {

    let currentTime = Date.parse('2026-07-27T08:00:00.000Z');
    let apsAuth = createApsAuth({ now : function() { return currentTime; } });
    let req = createRequest({}, 'session-1');

    apsAuth.storeUserTokens(req, {
        access_token  : 'access-1',
        refresh_token : 'refresh-1',
        expires_in    : 3600
    });

    assert.equal(req.session.headers.Authorization, 'Bearer access-1');
    assert.equal(req.session.headers.refresh_token, undefined);
    assert.equal(req.session.headers.expires, undefined);
    assert.equal(req.session.apsAuth.refresh_token, 'refresh-1');
    assert.equal(req.session.apsAuth.expires, '2026-07-27T09:00:00.000Z');
    assert.equal(req.session.apsAuth.token_obtained_at, '2026-07-27T08:00:00.000Z');

});

test('test mode refreshes concurrent Data Manager requests only once', async function() {

    let currentTime = Date.parse('2026-07-27T08:01:01.000Z');
    let refreshCalls = 0;
    let httpClient = {
        post : async function(url, data, config) {
            refreshCalls++;
            assert.match(data, /grant_type=refresh_token/);
            assert.match(data, /refresh_token=refresh-old/);
            assert.equal(config.headers['content-type'], 'application/x-www-form-urlencoded');
            return {
                data : {
                    access_token  : 'access-new',
                    refresh_token : 'refresh-new',
                    expires_in    : 3600
                }
            };
        }
    };
    let apsAuth = createApsAuth({
        httpClient,
        now : function() { return currentTime; },
        testRefreshAfterMs : 60 * 1000
    });
    let sessionA = {
        headers : {
            Authorization : 'Bearer access-old'
        },
        apsAuth : {
            refresh_token     : 'refresh-old',
            expires           : '2026-07-27T09:00:00.000Z',
            token_obtained_at : '2026-07-27T08:00:00.000Z'
        }
    };
    let sessionB = JSON.parse(JSON.stringify(sessionA));
    let reqA = createRequest(sessionA, 'session-2');
    let reqB = createRequest(sessionB, 'session-2');

    await Promise.all([
        runMiddleware(apsAuth.ensureFreshUserToken, reqA),
        runMiddleware(apsAuth.ensureFreshUserToken, reqB)
    ]);

    assert.equal(refreshCalls, 1);
    assert.equal(reqA.session.headers.Authorization, 'Bearer access-new');
    assert.equal(reqB.session.headers.Authorization, 'Bearer access-new');
    assert.equal(reqA.session.apsAuth.refresh_token, 'refresh-new');
    assert.equal(reqB.session.apsAuth.refresh_token, 'refresh-new');

});

test('does not refresh a token that is outside the refresh window', async function() {

    let currentTime = Date.parse('2026-07-27T08:00:00.000Z');
    let refreshCalls = 0;
    let apsAuth = createApsAuth({
        httpClient : {
            post : async function() {
                refreshCalls++;
            }
        },
        now : function() { return currentTime; },
        refreshWindowMs : 2 * 60 * 1000
    });
    let req = createRequest({
        headers : {
            Authorization : 'Bearer access-current'
        },
        apsAuth : {
            refresh_token : 'refresh-current',
            expires       : '2026-07-27T09:00:00.000Z'
        }
    }, 'session-3');

    await runMiddleware(apsAuth.ensureFreshUserToken, req);

    assert.equal(refreshCalls, 0);

});
