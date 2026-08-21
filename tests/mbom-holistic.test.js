const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourcePath = path.join(__dirname, '..', 'public', 'javascripts', 'custom', 'mbom.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function extractFunction(name) {
    const expression = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
    const match = expression.exec(source);
    if(!match) throw new Error('Could not find function ' + name);

    const start = match.index;
    const bodyStart = source.indexOf('{', start);
    let depth = 0;

    for(let index = bodyStart; index < source.length; index++) {
        if(source[index] === '{') depth++;
        if(source[index] === '}') {
            depth--;
            if(depth === 0) return source.slice(start, index + 1);
        }
    }

    throw new Error('Could not extract complete function ' + name);
}

const context = {
    console,
    Set,
    Promise,
    Number,
    String,
    Math,
    isBlank(value) {
        return value === null || typeof value === 'undefined' || value === '';
    },
    getBOMLinkedFieldLink(value) {
        if(!value) return '';
        if(typeof value === 'string') return value;
        return value.link || '';
    },
    getPLMItemLevelLink(value) {
        return value;
    },
    isAssemblyIndexNode() {
        return false;
    }
};

vm.createContext(context);
[
    'parseNumericValue',
    'normalizePLMLink',
    'getBOMBooleanValue',
    'getHolisticDirectPartIndexes',
    'getHolisticQuantity',
    'addHolisticTotal',
    'getHolisticEBOMTotals',
    'getHolisticMBOMPartKey',
    'isHolisticExpandableMBOMPart',
    'aggregateHolisticMBOMParts',
    'getHolisticComparisonState'
].forEach(function(name) {
    vm.runInContext(extractFunction(name), context);
});

async function run() {
    context.ebomPartsList = [
        { level : 0, link : '/api/v3/workspaces/1/items/1', quantity : 0 },
        { level : 1, link : '/api/v3/workspaces/1/items/10', quantity : 2, mbom : { link : '/api/v3/workspaces/1/items/110' } },
        { level : 2, link : '/api/v3/workspaces/1/items/100', partNumber : 'A', quantity : 3 },
        { level : 1, link : '/api/v3/workspaces/1/items/20', quantity : 1, mbom : { link : '/api/v3/workspaces/1/items/120' } },
        { level : 2, link : '/api/v3/workspaces/1/items/200', partNumber : 'B', quantity : 4 },
        { level : 1, link : '/api/v3/workspaces/1/items/30', quantity : 1, ignoreInMBOM : true },
        { level : 2, link : '/api/v3/workspaces/1/items/300', partNumber : 'IGNORED', quantity : 9 }
    ];

    const expected = vm.runInContext('getHolisticEBOMTotals()', context);
    assert.strictEqual(expected['/api/v3/workspaces/1/items/100'].quantity, 6);
    assert.strictEqual(expected['/api/v3/workspaces/1/items/200'].quantity, 4);
    assert.strictEqual(expected['/api/v3/workspaces/1/items/300'], undefined);

    const manufacturingParts = [
        { level : 0, link : '/api/v3/workspaces/1/items/500', quantity : 0 },
        { level : 1, link : '/api/v3/workspaces/1/items/501', quantity : 1, isProcess : true },
        { level : 2, link : '/api/v3/workspaces/1/items/200', partNumber : 'B', quantity : 4, isProcess : false },
        { level : 1, link : '/api/v3/workspaces/1/items/502', quantity : 1, isProcess : true },
        { level : 2, link : '/api/v3/workspaces/1/items/100', partNumber : 'A', quantity : 6, isProcess : false }
    ];
    const actual = {};
    context.manufacturingParts = manufacturingParts;
    context.actual = actual;
    await vm.runInContext(
        'aggregateHolisticMBOMParts(manufacturingParts, 0, 1, actual, new Set(), [])',
        context
    );

    assert.strictEqual(actual['/api/v3/workspaces/1/items/100'].quantity, 6);
    assert.strictEqual(actual['/api/v3/workspaces/1/items/200'].quantity, 4);

    context.fetchHolisticMBOMParts = async function(link) {
        assert.strictEqual(link, '/api/v3/workspaces/1/items/110');
        return [
            { level : 0, link : '/api/v3/workspaces/1/items/110', quantity : 0 },
            { level : 1, link : '/api/v3/workspaces/1/items/111', quantity : 1, isProcess : true },
            { level : 2, link : '/api/v3/workspaces/1/items/100', partNumber : 'A', quantity : 3, isProcess : false }
        ];
    };
    context.nestedManufacturingParts = [
        { level : 0, link : '/api/v3/workspaces/1/items/500', quantity : 0 },
        {
            level     : 1,
            link      : '/api/v3/workspaces/1/items/110',
            quantity  : 2,
            ebom      : { link : '/api/v3/workspaces/1/items/10' },
            isProcess : false
        }
    ];
    context.nestedActual = {};
    await vm.runInContext(
        'aggregateHolisticMBOMParts(nestedManufacturingParts, 0, 1, nestedActual, new Set(), [])',
        context
    );
    assert.strictEqual(context.nestedActual['/api/v3/workspaces/1/items/100'].quantity, 6);

    context.expected = expected;
    context.actual = actual;
    assert.strictEqual(vm.runInContext("getHolisticComparisonState(expected, actual, '/api/v3/workspaces/1/items/100')", context), 'match');

    actual['/api/v3/workspaces/1/items/100'].quantity = 5;
    assert.strictEqual(vm.runInContext("getHolisticComparisonState(expected, actual, '/api/v3/workspaces/1/items/100')", context), 'different');

    actual['/api/v3/workspaces/1/items/999'] = { quantity : 1, partNumbers : ['EXTRA'] };
    assert.strictEqual(vm.runInContext("getHolisticComparisonState(expected, actual, '/api/v3/workspaces/1/items/999')", context), 'additional');

    console.log('Holistic mBOM comparison tests passed.');
}

run().catch(function(error) {
    console.error(error);
    process.exitCode = 1;
});
