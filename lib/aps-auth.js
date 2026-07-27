const axios = require('axios');

const TOKEN_URL = 'https://developer.api.autodesk.com/authentication/v2/token';
const DEFAULT_REFRESH_WINDOW_MS = 2 * 60 * 1000;
const RECENT_REFRESH_TTL_MS = 30 * 1000;

function positiveMillisecondsFromSeconds(value) {

    let seconds = Number(value);

    return Number.isFinite(seconds) && (seconds > 0)
        ? seconds * 1000
        : 0;

}

function createApsAuth(options) {

    options = options || {};

    const httpClient = options.httpClient || axios;
    const now = options.now || Date.now;
    const refreshWindowMs = Number.isFinite(options.refreshWindowMs)
        ? options.refreshWindowMs
        : DEFAULT_REFRESH_WINDOW_MS;
    const testRefreshAfterMs = Number.isFinite(options.testRefreshAfterMs)
        ? options.testRefreshAfterMs
        : positiveMillisecondsFromSeconds(process.env.APS_TOKEN_REFRESH_TEST_SECONDS);
    const refreshRequests = new Map();

    function getUserTokenState(req) {

        if(!req.session) return {};
        if(req.session.apsAuth) return req.session.apsAuth;

        let headers = req.session.headers || {};

        return {
            expires           : headers.expires,
            refresh_token     : headers.refresh_token,
            token_obtained_at : headers.token_obtained_at
        };

    }

    function storeUserTokens(req, tokenData) {

        if(!req.session) throw new Error('Cannot store APS tokens without a session');
        if(!tokenData || !tokenData.access_token) throw new Error('APS token response does not contain an access token');

        let previousHeaders = req.session.headers || {};
        let previousTokenState = getUserTokenState(req);
        let expiresIn = Number(tokenData.expires_in);

        if(!Number.isFinite(expiresIn) || (expiresIn <= 0)) expiresIn = 3600;

        req.session.headers = {
            'Content-Type'      : previousHeaders['Content-Type'] || 'application/json',
            'Accept'            : previousHeaders.Accept || 'application/json',
            'X-Tenant'          : req.app.locals.tenant,
            'token'             : tokenData.access_token,
            'Authorization'     : 'Bearer ' + tokenData.access_token
        };
        req.session.apsAuth = {
            'expires'           : new Date(now() + (expiresIn * 1000)).toISOString(),
            'refresh_token'     : tokenData.refresh_token || previousTokenState.refresh_token,
            'token_obtained_at' : new Date(now()).toISOString()
        };

        return req.session.headers;

    }

    function shouldRefreshUserToken(req) {

        if(!req.session || !req.session.headers) return false;

        let headers = req.session.headers;
        let tokenState = getUserTokenState(req);

        if(!headers.Authorization || !tokenState.refresh_token) return false;

        let currentTime = now();
        let expiresAt = Date.parse(tokenState.expires);

        if(!Number.isFinite(expiresAt)) return true;

        if((testRefreshAfterMs > 0) && tokenState.token_obtained_at) {
            let obtainedAt = Date.parse(tokenState.token_obtained_at);
            if(Number.isFinite(obtainedAt) && (currentTime >= (obtainedAt + testRefreshAfterMs))) return true;
        }

        return currentTime >= (expiresAt - refreshWindowMs);

    }

    function requestRefreshedTokens(req, refreshToken) {

        if(refreshRequests.has(refreshToken)) return refreshRequests.get(refreshToken);

        let data = new URLSearchParams({
            grant_type    : 'refresh_token',
            refresh_token : refreshToken,
            client_id     : req.app.locals.clientId
        });

        let refreshRequest = httpClient.post(TOKEN_URL, data.toString(), {
            headers : {
                'accept'       : 'application/json',
                'content-type' : 'application/x-www-form-urlencoded'
            }
        }).then(function(response) {
            console.log();
            console.log('  APS access token refreshed successfully');
            if(testRefreshAfterMs > 0) {
                console.log('  Token refresh test mode is active (' + (testRefreshAfterMs / 1000) + ' seconds)');
            }
            console.log();

            return response.data;
        });

        refreshRequests.set(refreshToken, refreshRequest);

        refreshRequest.finally(function() {
            let timer = setTimeout(function() {
                if(refreshRequests.get(refreshToken) === refreshRequest) refreshRequests.delete(refreshToken);
            }, RECENT_REFRESH_TTL_MS);
            if(typeof timer.unref === 'function') timer.unref();
        }).catch(function() {
            // The middleware reports the original refresh error.
        });

        return refreshRequest;

    }

    function saveSession(req) {

        return new Promise(function(resolve, reject) {
            if(!req.session || (typeof req.session.save !== 'function')) return resolve();
            req.session.save(function(error) {
                if(error) reject(error);
                else resolve();
            });
        });

    }

    async function refreshUserToken(req) {

        let refreshToken = getUserTokenState(req).refresh_token;
        let tokenData = await requestRefreshedTokens(req, refreshToken);

        storeUserTokens(req, tokenData);
        await saveSession(req);

        return tokenData;

    }

    async function ensureFreshUserToken(req, res, next) {

        if(!shouldRefreshUserToken(req)) return next();

        try {
            await refreshUserToken(req);
            next();
        } catch(error) {
            let status = (error.response && error.response.status) || 401;
            let details = (error.response && error.response.data) || error.message;

            console.error('  APS access token refresh failed', details);

            res.status(status).json({
                error   : true,
                status  : status,
                message : 'The Autodesk session could not be refreshed. Please sign in again.'
            });
        }

    }

    return {
        ensureFreshUserToken,
        getUserTokenState,
        refreshUserToken,
        shouldRefreshUserToken,
        storeUserTokens
    };

}

const apsAuth = createApsAuth();

module.exports = {
    createApsAuth,
    ensureFreshUserToken : apsAuth.ensureFreshUserToken,
    getUserTokenState    : apsAuth.getUserTokenState,
    refreshUserToken     : apsAuth.refreshUserToken,
    shouldRefreshUserToken : apsAuth.shouldRefreshUserToken,
    storeUserTokens      : apsAuth.storeUserTokens
};
