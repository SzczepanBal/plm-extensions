(function(global) {
    'use strict';

    const proxyBaseUrl = '/plm/custom-erp/';

    function isBlankValue(value) {
        return value === null || typeof value === 'undefined' || String(value).trim() === '';
    }

    function getHash(response) {
        let containers = [
            response,
            response && response.data,
            response && response.data && response.data.data,
            response && response.body,
            response && response.data && response.data.body
        ];
        for(let container of containers) {
            if(container && typeof container === 'object' && !isBlankValue(container.hash)) return String(container.hash);
            if(typeof container === 'string' && container.indexOf('v1:') === 0) return container;
        }
        return '';
    }

    function calculateHash(hashInput) {
        return $.ajax({
            url         : proxyBaseUrl + 'hash',
            method      : 'POST',
            contentType : 'application/json',
            data        : JSON.stringify(hashInput)
        }).then(function(response) {
            let hash = getHash(response);
            if(isBlankValue(hash)) throw new Error('Serwer nie zwrócił skrótu danych ERP.');
            return hash;
        });
    }

    function request(callName, payload, options) {
        options = options || {};
        let url = proxyBaseUrl + (options.exportOnly ? 'export-request/' : '') + callName;
        return $.post(url, payload, null, 'json');
    }

    function getOperationMapping(mapping, operationName) {
        let operations = (mapping && mapping.operations) || {};
        let operation = operations[operationName] || {};
        if(isBlankValue(operation.extends)) return operation;

        let base = operations[operation.extends] || {};
        return Object.assign({}, base, operation, {
            fields           : Object.assign({}, base.fields || {}, operation.fields || {}),
            defaults         : Object.assign({}, base.defaults || {}, operation.defaults || {}),
            propertyProfiles : Object.assign({}, base.propertyProfiles || {}, operation.propertyProfiles || {})
        });
    }

    function execute(callName, payload, hashInput, options) {
        return calculateHash(hashInput).then(function(hash) {
            return request(callName, payload, options).then(function(response) {
                return { response : response, hash : hash, callName : callName, payload : payload };
            });
        });
    }

    function getResponseBody(response) {
        if(!response || !response.data) return null;
        if(response.data.body && typeof response.data.body === 'object') return response.data.body;
        if(response.data.response && typeof response.data.response === 'object') return response.data.response;
        return null;
    }

    function getPartIndex(response) {
        let body = getResponseBody(response);
        if(!body) return '';
        for(let key of ['indeks_czesci', 'indeks', 'Indeks_czesci', 'INDEKS_CZESCI']) {
            if(!isBlankValue(body[key])) return String(body[key]);
        }
        return '';
    }

    function getVersionIdFromBody(body) {
        if(!body) return '';
        let value = isBlankValue(body.id_wersji) ? body.ID_WERSJI : body.id_wersji;
        let number = Number(value);
        return isBlankValue(value) || Number.isNaN(number) ? '' : Math.trunc(number);
    }

    function getVersionId(response) {
        return getVersionIdFromBody(getResponseBody(response));
    }

    function isSuccess(response) {
        return !!response && !response.error && Number(response.status) === 200;
    }

    function getProductSuccessFields(result, fieldIds) {
        let fields = [{ fieldId : fieldIds.hash, value : 'pending:' + result.hash }];
        let partIndex = getPartIndex(result.response);
        if(!isBlankValue(partIndex)) fields.push({ fieldId : fieldIds.partIndex, value : partIndex });
        if(result.callName === 'add-product') fields.push({ fieldId : fieldIds.sentToERP, value : true });
        return fields;
    }

    global.erpClient = {
        proxyBaseUrl           : proxyBaseUrl,
        calculateHash          : calculateHash,
        execute                : execute,
        request                : request,
        getOperationMapping    : getOperationMapping,
        getHash                : getHash,
        getResponseBody        : getResponseBody,
        getPartIndex           : getPartIndex,
        getVersionId           : getVersionId,
        getVersionIdFromBody   : getVersionIdFromBody,
        getProductSuccessFields: getProductSuccessFields,
        isSuccess              : isSuccess
    };
})(typeof window !== 'undefined' ? window : globalThis);
