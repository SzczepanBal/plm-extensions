const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const crypto  = require('crypto');

module.exports = function createErpRouter(dependencies) {

    const router = express.Router();
    const sendResponse = dependencies.sendResponse;
    const isBlank = dependencies.isBlank;
    const createServerFolderPath = dependencies.createServerFolderPath;

    const customErpCalls = {
        'api-docs' : {
            method      : 'GET',
            path        : '/Api2/api-docs',
            defaultBody : {}
        },
        'get-product-list' : {
            method      : 'POST',
            path        : '/Api2/get-product-list',
            defaultBody : { id_grupy : 'WIE' }
        },
        'get-product-details' : {
            method      : 'POST',
            path        : '/Api2/get-product-details',
            defaultBody : { indeks_czesci : '10936' }
        },
        'add-product' : {
            method      : 'POST',
            path        : '/Api2/add-product',
            defaultBody : {
                indeks           : '000000144-M',
                nazwa_czesci     : '000000144-M',
                id_grupy         : 'MZL',
                jednostka_miary  : 'szt',
                kontrola_serii   : 'T',
                numery_seryjne   : 'WPD',
                edycja_wh         : 'T',
                wlasnosci        : [
                    { Opis               : '000000144-M' },
                    { Nazwa              : '000000144-M' },
                    { Rewizja            : 'Working' },
                    { 'Materiał'         : 'Working' },
                    { 'Specyfikacja'     : 'Working' },
                    { Status             : 'Unreleased' },
                    { 'Grupa produktowa' : 'PCP' },
                    { 'Typ czesci'       : 'O' },
                    { Lifecycle          : 'Working' },
                    { 'Data zwolnienia'  : '2025-12-09' }
                ]
            }
        },
        'modify-product' : {
            method      : 'POST',
            path        : '/Api2/modify-product',
            defaultBody : {
                indeks_czesci                 : 'BWE-B-150-B/N',
                numer_katalogowy              : 'BETONIARKA',
                kontrola_serii                : 'T',
                numery_seryjne                : 'WPD',
                edycja_wh                      : 'T'
            }
        },
        'get-technology-list' : {
            method      : 'POST',
            path        : '/Api2/get-technology-list',
            defaultBody : { data_od : '2023.07.25T00:00:00' }
        },
        'get-technology-details' : {
            method      : 'POST',
            path        : '/Api2/get-technology-details',
            defaultBody : { id_wersji : '344220' }
        },
        'add-technology' : {
            method      : 'POST',
            path        : '/Api2/add-technology',
            defaultBody : {
                indeks         : '000000097',
                nazwa_czesci   : 'PCP_DHPi MONOTEC_008_Z_000000097',
                opis           : 'DHPiM 8 Taca ociekowa - DHPiM8.TO.00.00_Rev1_ Test New',
                rewizja        : 'Working',
                czy_zatwierdzona : 'N',
                wlasnosci      : [
                    { 'Grupa Produktowa' : 'PCP' },
                    { 'Typ czesci'       : 'Z' }
                ],
                operacje       : [
                    {
                        numer_operacji : '10',
                        kod_operacji   : 'SPW',
                        gniazdo        : 'wirtualne',
                        stanowisko     : 'wirtualne'
                    },
                    {
                        numer_operacji : '20',
                        kod_operacji   : 'MON',
                        gniazdo        : 'wirtualne',
                        stanowisko     : 'wirtualne'
                    }
                ],
                struktura      : [
                    {
                        numer_operacji  : '10',
                        indeks_skladowy : 'USZ-SIL-300C',
                        rewizja         : 'Working',
                        ilosc_stala     : 0,
                        ilosc_jednostek : 1.0
                    }
                ],
                zalaczniki     : [
                    {
                        zrodlo : 'https://<tenant>.autodeskplm360.net/plm/workspaces/<workspaceId>/items/attachments?view=full&tab=attachments&mode=view&itemId=urn%60adsk,plm%60tenant,workspace,item%60<TENANT>,<workspaceId>,<itemId>',
                        opis   : 'Dokumenty w PLM'
                    }
                ]
            }
        },
        'modify-technology' : {
            method      : 'POST',
            path        : '/Api2/modify-technology',
            defaultBody : {
                id_wersji  : 378,
                zablokowana: "N",
                zalaczniki : [
                    {
                        zrodlo : 'https://<tenant>.autodeskplm360.net/plm/workspaces/<workspaceId>/items/attachments?view=full&tab=attachments&mode=view&itemId=urn%60adsk,plm%60tenant,workspace,item%60<TENANT>,<workspaceId>,<itemId>',
                        opis   : 'Dokumenty w PLM'
                    }
                ]
            }
        }
    };

    function applyRequiredProductControls(req, callName, body) {
        if(callName !== 'add-product' && callName !== 'modify-product') return body;

        let source = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};
        let mapping = (((req.app.locals.common || {}).erp || {}).mapping || {}).operations || {};
        let defaults = (mapping.addProduct || {}).defaults || {};
        let result = Object.assign({}, source, {
            kontrola_serii : defaults.serialControl || 'T',
            numery_seryjne : defaults.serialNumbers || 'WPD',
            edycja_wh       : defaults.commercialVersionEditable || 'T'
        });

        // Do not forward the obsolete field name alongside the ERP contract field.
        delete result.wersja_handlowa_edytowalna;
        return result;
    }
    
    function getCustomErpConfig(req) {
        let erp = req.app.locals.erp || {};
        let baseUrl = (erp.baseUrl || '').replace(/\/+$/, '');
        let integrationId = erp.integrationId || '';
        let username = erp.username || '';
        let password = erp.password || '';
    
        return {
            baseUrl       : baseUrl,
            integrationId : integrationId,
            username      : username,
            password      : password,
            simulationMode: erp.simulationMode === true
        };
    }
    
    function getSafeCustomErpTargetUrl(targetUrl) {
        try {
            let url = new URL(targetUrl);
            return url.origin + url.pathname;
        } catch(error) {
            return '';
        }
    }
    
    function validateCustomErpConfig(req, res) {
        let erp = getCustomErpConfig(req);

        if(erp.simulationMode) return erp;
    
        if(isBlank(erp.baseUrl) || isBlank(erp.integrationId) || isBlank(erp.username) || isBlank(erp.password)) {
            sendResponse(req, res, {
                data : {
                    source  : 'custom-erp',
                    message : 'ERP environment settings are incomplete. Please provide baseUrl, integrationId, username and password.'
                },
                status : 500
            }, true);
            return null;
        }
    
        return erp;
    }

    function getCustomErpSimulationBody(callName, body) {
        let requestBody = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};
        let result = { simulationMode : true };

        if(callName === 'add-product' || callName === 'modify-product') {
            result.indeks_czesci = requestBody.indeks_czesci || requestBody.indeks || '';
        }

        if(callName === 'add-technology' || callName === 'modify-technology') {
            let existingVersionId = Number(requestBody.id_wersji);
            if(!Number.isNaN(existingVersionId) && existingVersionId > 0) {
                result.id_wersji = Math.trunc(existingVersionId);
            } else {
                let seed = [callName, requestBody.indeks || '', requestBody.rewizja || ''].join('|');
                let digest = crypto.createHash('sha256').update(seed, 'utf8').digest('hex');
                result.id_wersji = 900000000 + (parseInt(digest.substring(0, 8), 16) % 99999999);
            }
        }

        return result;
    }

    function invokeCustomErpSimulation(req, res, callName, call, body) {
        let responseBody = getCustomErpSimulationBody(callName, body);
        let requestDump = saveCustomErpRequestDump(callName, body);
        let responseDump = saveCustomErpResponseDump(callName, responseBody, false);

        sendResponse(req, res, {
            data : {
                source          : 'custom-erp-simulation',
                call            : callName,
                method          : call.method,
                status          : 200,
                statusText      : 'SIMULATED',
                simulationMode  : true,
                body            : responseBody,
                requestDumpFile : requestDump.filePath,
                requestDumpUrl  : requestDump.fileUrl,
                dumpFile        : responseDump.filePath,
                dumpUrl         : responseDump.fileUrl
            },
            status : 200
        }, false);
    }
    
    function sanitizeCustomErpDumpFilePart(value) {
        return String(value || '')
            .replace(/[^a-zA-Z0-9_-]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            .toLowerCase() || 'unknown';
    }
    
    function getCustomErpDumpContent(body) {
        if(typeof body === 'string') {
            try {
                return {
                    extension : 'json',
                    content   : JSON.stringify(JSON.parse(body), null, 2)
                };
            } catch(error) {
                return {
                    extension : 'txt',
                    content   : body
                };
            }
        }
    
        return {
            extension : 'json',
            content   : JSON.stringify(body || {}, null, 2)
        };
    }
    
    function saveCustomErpResponseDump(callName, body, isError) {
        let date = new Date();
        let dateFolder = date.getFullYear() + '-'
            + String(date.getMonth() + 1).padStart(2, '0') + '-'
            + String(date.getDate()).padStart(2, '0');
        let timePart = String(date.getHours()).padStart(2, '0')
            + String(date.getMinutes()).padStart(2, '0')
            + String(date.getSeconds()).padStart(2, '0')
            + '-' + String(date.getMilliseconds()).padStart(3, '0');
        let callPart = sanitizeCustomErpDumpFilePart(callName);
        let statusPart = isError ? 'error' : 'success';
        let dump = getCustomErpDumpContent(body);
        let folderPath = 'storage/temp/custom-erp/' + dateFolder;
        let fileName = 'erp-' + callPart + '-' + statusPart + '-' + timePart + '.' + dump.extension;
    
        createServerFolderPath(folderPath, false);
        fs.writeFileSync(folderPath + '/' + fileName, dump.content, 'utf8');
    
        return {
            fileName : fileName,
            filePath : folderPath + '/' + fileName,
            fileUrl  : '/storage/temp/custom-erp/' + dateFolder + '/' + fileName
        };
    }
    
    function saveCustomErpRequestDump(callName, body) {
        let date = new Date();
        let dateFolder = date.getFullYear() + '-'
            + String(date.getMonth() + 1).padStart(2, '0') + '-'
            + String(date.getDate()).padStart(2, '0');
        let timePart = String(date.getHours()).padStart(2, '0')
            + String(date.getMinutes()).padStart(2, '0')
            + String(date.getSeconds()).padStart(2, '0')
            + '-' + String(date.getMilliseconds()).padStart(3, '0');
        let callPart = sanitizeCustomErpDumpFilePart(callName);
        let dump = getCustomErpDumpContent(body);
        let folderPath = 'storage/temp/custom-erp/' + dateFolder;
        let fileName = 'erp-' + callPart + '-request-' + timePart + '.' + dump.extension;
    
        createServerFolderPath(folderPath, false);
        fs.writeFileSync(folderPath + '/' + fileName, dump.content, 'utf8');
    
        return {
            fileName : fileName,
            filePath : folderPath + '/' + fileName,
            fileUrl  : '/storage/temp/custom-erp/' + dateFolder + '/' + fileName
        };
    }
    
    function exportCustomErpRequestDump(req, res, callName) {
        let call = customErpCalls[callName];
    
        if(typeof call === 'undefined') {
            sendResponse(req, res, {
                data : {
                    source  : 'custom-erp',
                    message : 'Unknown ERP call: ' + callName
                },
                status : 404
            }, true);
            return;
        }
    
        let body = (req.body && Object.keys(req.body).length > 0) ? req.body : call.defaultBody;
        body = applyRequiredProductControls(req, callName, body);
        let requestDump = saveCustomErpRequestDump(callName, body);
    
        sendResponse(req, res, {
            data : {
                source          : 'custom-erp',
                call            : callName,
                method          : call.method,
                mode            : 'test-run-export',
                body            : body,
                requestDumpFile : requestDump.filePath,
                requestDumpUrl  : requestDump.fileUrl
            },
            status : 200
        }, false);
    }
    
    function buildCustomErpUrl(req, callName) {
        let call = customErpCalls[callName];
        if(typeof call === 'undefined') return '';
    
        let erp = getCustomErpConfig(req);
        let params = new URLSearchParams({
            integrationId : erp.integrationId,
            username      : erp.username,
            password      : erp.password
        });
    
        return erp.baseUrl + call.path + '?' + params.toString();
    }
    
    function getCustomErpApiDocsHeaders(targetUrl, rawBody) {
        let url = new URL(targetUrl);
    
        return {
            'Content-Type'    : 'application/json',
            'Content-Length'  : Buffer.byteLength(rawBody).toString(),
            'Host'            : url.host,
            'User-Agent'      : 'PostmanRuntime/7.51.1',
            'Accept'          : '*/*',
            'Accept-Encoding' : 'gzip, deflate, br',
            'Connection'      : 'keep-alive'
        };
    }
    
    function invokeCustomErpApiDocsCall(req, res, targetUrl) {
        let rawBody = '{}';
        let headers = getCustomErpApiDocsHeaders(targetUrl, rawBody);
    
        axios({
            method  : 'get',
            url     : targetUrl,
            headers : headers,
            data    : rawBody,
            timeout : 15000,
            transformRequest : [function(data) { return data; }]
        }).then(function(response) {
    
            sendResponse(req, res, {
                data : {
                    source     : 'custom-erp',
                    call       : 'api-docs',
                    targetUrl  : getSafeCustomErpTargetUrl(targetUrl),
                    method     : 'GET',
                    status     : response.status,
                    statusText : response.statusText,
                    body       : response.data
                },
                status : response.status
            }, false);
    
        }).catch(function(error) {
            axios({
                method  : 'post',
                url     : targetUrl,
                headers : headers,
                data    : rawBody,
                timeout : 15000,
                transformRequest : [function(data) { return data; }]
            }).then(function(response) {
    
                sendResponse(req, res, {
                    data : {
                        source     : 'custom-erp',
                        call       : 'api-docs',
                        targetUrl  : getSafeCustomErpTargetUrl(targetUrl),
                        method     : 'POST',
                        status     : response.status,
                        statusText : response.statusText,
                        body       : response.data,
                        fallback   : 'GET failed, POST succeeded'
                    },
                    status : response.status
                }, false);
    
            }).catch(function(fallbackError) {
                let errorResponse = fallbackError.response || error.response || {
                    status : 500,
                    data   : {
                        message : fallbackError.message || error.message || 'ERP request failed'
                    }
                };
    
                sendResponse(req, res, {
                    data : {
                        source    : 'custom-erp',
                        call      : 'api-docs',
                        targetUrl : getSafeCustomErpTargetUrl(targetUrl),
                        method    : 'GET',
                        error     : error.message || '',
                        fallback  : {
                            method : 'POST',
                            error  : fallbackError.message || ''
                        },
                        response  : errorResponse.data || {}
                    },
                    status : errorResponse.status || 500
                }, true);
            });
        });
    }
    
    function invokeCustomErpCall(req, res, callName, fallbackMethod) {
        let call = customErpCalls[callName];
        if(typeof call === 'undefined') {
            sendResponse(req, res, {
                data : {
                    source  : 'custom-erp',
                    message : 'Unknown ERP call: ' + callName
                },
                status : 404
            }, true);
            return;
        }
    
        let erpSettings = getCustomErpConfig(req);
    
        let erp = validateCustomErpConfig(req, res);
        if(erp === null) return;
    
        let targetUrl = buildCustomErpUrl(req, callName);
        let body = (req.body && Object.keys(req.body).length > 0) ? req.body : call.defaultBody;
        body = applyRequiredProductControls(req, callName, body);

        if(erpSettings.simulationMode) {
            invokeCustomErpSimulation(req, res, callName, call, body);
            return;
        }
    
        if(callName === 'api-docs') {
            invokeCustomErpApiDocsCall(req, res, targetUrl);
            return;
        }
    
        let requestConfig = {
            method  : call.method.toLowerCase(),
            url     : targetUrl,
            timeout : 15000
        };
        let requestDump = null;
    
        if(call.method !== 'GET') {
            requestConfig.data = body;
            requestDump = saveCustomErpRequestDump(callName, body);
        }
    
        axios(requestConfig).then(function(response) {
            let responseDump = saveCustomErpResponseDump(callName, response.data, false);
    
            sendResponse(req, res, {
                data : {
                    source     : 'custom-erp',
                    call       : callName,
                    targetUrl  : getSafeCustomErpTargetUrl(targetUrl),
                    method     : call.method,
                    status     : response.status,
                    statusText : response.statusText,
                    body       : response.data,
                    requestDumpFile : (requestDump) ? requestDump.filePath : '',
                    requestDumpUrl  : (requestDump) ? requestDump.fileUrl  : '',
                    dumpFile   : responseDump.filePath,
                    dumpUrl    : responseDump.fileUrl
                },
                status : response.status
            }, false);
    
        }).catch(function(error) {
            if(call.method === 'GET' && fallbackMethod === 'POST') {
                axios({
                    method  : 'post',
                    url     : targetUrl,
                    data    : body || {},
                    timeout : 15000
                }).then(function(response) {
    
                    sendResponse(req, res, {
                        data : {
                            source     : 'custom-erp',
                            call       : callName,
                            targetUrl  : getSafeCustomErpTargetUrl(targetUrl),
                            method     : 'POST',
                            status     : response.status,
                            statusText : response.statusText,
                            body       : response.data,
                            fallback   : 'GET failed, POST succeeded'
                        },
                        status : response.status
                    }, false);
    
                }).catch(function(fallbackError) {
                    let errorResponse = fallbackError.response || error.response || {
                        status : 500,
                        data   : {
                            message : fallbackError.message || error.message || 'ERP request failed'
                        }
                    };
    
                    sendResponse(req, res, {
                        data : {
                            source    : 'custom-erp',
                            call      : callName,
                            targetUrl : getSafeCustomErpTargetUrl(targetUrl),
                            method    : call.method,
                            error     : error.message || '',
                            fallback  : {
                                method : 'POST',
                                error  : fallbackError.message || ''
                            },
                            response  : errorResponse.data || {}
                        },
                        status : errorResponse.status || 500
                    }, true);
                });
    
                return;
            }
    
            let errorResponse = error.response || {
                status : 500,
                data   : {
                    message : error.message || 'ERP request failed'
                }
            };
            let responseDump = saveCustomErpResponseDump(callName, errorResponse.data || {}, true);
    
            sendResponse(req, res, {
                data : {
                    source    : 'custom-erp',
                    call      : callName,
                    targetUrl : getSafeCustomErpTargetUrl(targetUrl),
                    method    : call.method,
                    error     : error.message || '',
                    response  : errorResponse.data || {},
                    requestDumpFile : (requestDump) ? requestDump.filePath : '',
                    requestDumpUrl  : (requestDump) ? requestDump.fileUrl  : '',
                    dumpFile  : responseDump.filePath,
                    dumpUrl   : responseDump.fileUrl
                },
                status : errorResponse.status || 500
            }, true);
        });
    }
    
    router.get('/custom-erp-calls', function(req, res) {
        let erp = validateCustomErpConfig(req, res);
        if(erp === null) return;
    
        let result = Object.keys(customErpCalls).map(function(callName) {
            return {
                name        : callName,
                method      : customErpCalls[callName].method,
                path        : customErpCalls[callName].path,
                defaultBody : customErpCalls[callName].defaultBody,
                proxyUrl    : '/plm/custom-erp/' + callName
            };
        });
    
        sendResponse(req, res, {
            data : result,
            status : 200
        }, false);
    });

    router.get('/custom-erp/mapping', function(req, res) {
        sendResponse(req, res, {
            data   : (req.app.locals.common.erp || {}).mapping || {},
            status : 200
        }, false);
    });
    
    function canonicalizeERPHashValue(value) {
        if(Array.isArray(value)) {
            return value.map(canonicalizeERPHashValue);
        }
    
        if(value && typeof value === 'object') {
            return Object.keys(value).sort().reduce(function(result, key) {
                if(typeof value[key] !== 'undefined') {
                    result[key] = canonicalizeERPHashValue(value[key]);
                }
                return result;
            }, {});
        }
    
        return value;
    }
    
    function createERPHash(value) {
        let canonicalValue = canonicalizeERPHashValue(value);
        let serializedValue = JSON.stringify(canonicalValue);
        return 'v1:' + crypto.createHash('sha256').update(serializedValue, 'utf8').digest('hex');
    }
    
    router.post('/custom-erp/hash', function(req, res) {
        try {
            sendResponse(req, res, {
                data : {
                    hash : createERPHash(req.body)
                },
                status : 200
            }, false);
        } catch(error) {
            sendResponse(req, res, {
                message : 'Nie udało się obliczyć skrótu danych ERP.',
                data    : { error : error.message || String(error) },
                status  : 500
            }, true);
        }
    });
    
    router.get('/custom-erp/:callName', function(req, res) {
        invokeCustomErpCall(req, res, req.params.callName, 'POST');
    });
    
    router.post('/custom-erp/export-request/:callName', function(req, res) {
        exportCustomErpRequestDump(req, res, req.params.callName);
    });
    
    router.post('/custom-erp/:callName', function(req, res) {
        invokeCustomErpCall(req, res, req.params.callName, null);
    });
    
    function handleCustomErpStatus(req, res) {
        invokeCustomErpCall(req, res, 'api-docs', 'POST');
    }
    
    router.get('/custom-erp-status', handleCustomErpStatus);
    router.post('/custom-erp-status', handleCustomErpStatus);

    return router;

};
