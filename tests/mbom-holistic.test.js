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
    rawMaterialAccountingUnitFieldId : 'JEDNOSTKA_ROZLICZENIOWA',
    rawMaterialAccountingQuantityFieldId : 'ILOSC_ROZLICZENIOWA',
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
    getBOMPartFieldValue(part, fieldId) {
        const field = Array.isArray(part.fields)
            ? part.fields.find((candidate) => candidate.fieldId === fieldId)
            : null;
        return field ? field.value : null;
    },
    getSectionFieldValue(sections, fieldId, defaultValue, property) {
        for(const section of (Array.isArray(sections) ? sections : [])) {
            const field = Array.isArray(section.fields)
                ? section.fields.find((candidate) => candidate.id === fieldId)
                : null;
            if(!field || field.value === null || typeof field.value === 'undefined') continue;
            if(typeof field.value !== 'object') return field.value;
            if(property === 'object') return field.value;
            return field.value[property];
        }
        return defaultValue;
    },
    getAddProcessItemTitle(item) {
        return item && item.title ? item.title : '';
    },
    isAssemblyIndexNode() {
        return false;
    }
};

vm.createContext(context);
[
    'normalizeComparisonValue',
    'normalizeMBOMUnitOfMeasureValue',
    'normalizeERPTechnologyUnitOfMeasure',
    'normalizeRawMaterialUnitForComparison',
    'rawMaterialUnitsMatch',
    'getValidatedRawMaterialInsertQuantity',
    'getMBOMAccountingFieldValue',
    'getMBOMAccountingUnit',
    'getMBOMAccountingQuantity',
    'getMBOMAccountingUnitFromItemDetails',
    'getRawMaterialUnitOfMeasureFromItemDetails',
    'normalizeProcessLookupName',
    'findAddProcessWorkspaceItemByName',
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
    'getHolisticComparisonState',
    'getMBOMSaveLink',
    'getMBOMChildSaveLink',
    'setHolisticItemState'
].forEach(function(name) {
    vm.runInContext(extractFunction(name), context);
});

async function run() {
    context.accountingPart = {
        details : {
            JEDNOSTKA_ROZLICZENIOWA : { title : 'Kilogram' },
            ILOSC_ROZLICZENIOWA : '1,35'
        }
    };
    assert.strictEqual(vm.runInContext('getMBOMAccountingUnit(accountingPart)', context), 'Kilogram');
    assert.strictEqual(vm.runInContext('getMBOMAccountingQuantity(accountingPart)', context), 1.35);
    assert.strictEqual(vm.runInContext("rawMaterialUnitsMatch('Kilogram', 'kg')", context), true);
    assert.strictEqual(vm.runInContext("rawMaterialUnitsMatch('m', 'Meter')", context), true);
    assert.strictEqual(vm.runInContext("rawMaterialUnitsMatch('m2', 'Square Meter')", context), true);
    assert.strictEqual(vm.runInContext("rawMaterialUnitsMatch('mm', 'Millimeter')", context), true);
    assert.strictEqual(vm.runInContext("rawMaterialUnitsMatch('cm2', 'Square Centimeter')", context), true);
    assert.strictEqual(vm.runInContext("rawMaterialUnitsMatch('m3', 'Cubic Meter')", context), true);
    assert.strictEqual(vm.runInContext("rawMaterialUnitsMatch('l', 'Liter')", context), true);
    assert.strictEqual(vm.runInContext("rawMaterialUnitsMatch('g', 'Gram')", context), true);
    assert.strictEqual(vm.runInContext("rawMaterialUnitsMatch('szt.', 'Each')", context), true);
    assert.strictEqual(vm.runInContext("rawMaterialUnitsMatch('min', 'Minute')", context), true);
    assert.strictEqual(vm.runInContext("rawMaterialUnitsMatch('piece', 'piece')", context), true);
    assert.strictEqual(vm.runInContext("rawMaterialUnitsMatch('kg', 'meter')", context), false);
    assert.strictEqual(vm.runInContext("rawMaterialUnitsMatch('', 'kg')", context), false);
    assert.strictEqual(vm.runInContext("getValidatedRawMaterialInsertQuantity('2,5', 'kg', 'Kilogram')", context), 2.5);
    assert.strictEqual(vm.runInContext("Number.isNaN(getValidatedRawMaterialInsertQuantity('2,5', 'kg', 'Meter'))", context), true);
    assert.strictEqual(vm.runInContext("Number.isNaN(getValidatedRawMaterialInsertQuantity('2,5', '', 'kg'))", context), true);
    assert.strictEqual(vm.runInContext("Number.isNaN(getValidatedRawMaterialInsertQuantity('', 'kg', 'kg'))", context), true);

    context.rawMaterialDetails = {
        sections : [{
            fields : [
                { id : 'JEDNOSTKA_ROZLICZENIOWA', value : { title : 'kg' } },
                { id : 'UOM', value : { title : 'Kilogram' } }
            ]
        }]
    };
    assert.strictEqual(
        vm.runInContext('getMBOMAccountingUnitFromItemDetails(rawMaterialDetails)', context),
        'kg'
    );
    assert.strictEqual(
        vm.runInContext('getRawMaterialUnitOfMeasureFromItemDetails(rawMaterialDetails)', context),
        'Kilogram'
    );
    assert.strictEqual(
        vm.runInContext("rawMaterialUnitsMatch(getMBOMAccountingUnitFromItemDetails(rawMaterialDetails), getRawMaterialUnitOfMeasureFromItemDetails(rawMaterialDetails))", context),
        true
    );

    context.rawMaterialAccountingUnitDetails = {
        sections : [{
            fields : [
                { id : 'JEDNOSTKA_ROZLICZENIOWA', value : { title : 'Kilogram' } }
            ]
        }]
    };
    assert.strictEqual(
        vm.runInContext('getRawMaterialUnitOfMeasureFromItemDetails(rawMaterialAccountingUnitDetails)', context),
        'Kilogram'
    );
    assert.strictEqual(
        vm.runInContext("rawMaterialUnitsMatch('kg', getRawMaterialUnitOfMeasureFromItemDetails(rawMaterialAccountingUnitDetails))", context),
        true
    );

    context.processItems = [
        { title : 'Gięcie' },
        { title : 'Cięcie' },
        { title : 'Spawanie' }
    ];
    assert.strictEqual(
        vm.runInContext("normalizeProcessLookupName('Cięcie')", context),
        'ciecie'
    );
    assert.strictEqual(
        vm.runInContext("findAddProcessWorkspaceItemByName(processItems, 'Ciecie').title", context),
        'Cięcie'
    );

    context.ebomPartsList = [
        { level : 0, link : '/api/v3/workspaces/1/items/1', quantity : 0 },
        { level : 1, link : '/api/v3/workspaces/1/items/10', quantity : 2, mbom : { link : '/api/v3/workspaces/1/items/110' } },
        { level : 2, link : '/api/v3/workspaces/1/items/100', root : '/api/v3/workspaces/1/items/1000', partNumber : 'A', quantity : 3 },
        { level : 1, link : '/api/v3/workspaces/1/items/20', quantity : 1, mbom : { link : '/api/v3/workspaces/1/items/120' } },
        { level : 2, link : '/api/v3/workspaces/1/items/200', root : '/api/v3/workspaces/1/items/2000', partNumber : 'B', quantity : 4 },
        { level : 1, link : '/api/v3/workspaces/1/items/30', quantity : 1, ignoreInMBOM : true },
        { level : 2, link : '/api/v3/workspaces/1/items/300', partNumber : 'IGNORED', quantity : 9 }
    ];

    const expected = vm.runInContext('getHolisticEBOMTotals()', context);
    assert.strictEqual(expected['/api/v3/workspaces/1/items/1000'].quantity, 6);
    assert.strictEqual(expected['/api/v3/workspaces/1/items/2000'].quantity, 4);
    assert.strictEqual(expected['/api/v3/workspaces/1/items/300'], undefined);

    const manufacturingParts = [
        { level : 0, link : '/api/v3/workspaces/1/items/500', quantity : 0 },
        { level : 1, link : '/api/v3/workspaces/1/items/501', quantity : 1, isProcess : true },
        { level : 2, link : '/api/v3/workspaces/1/items/201', ebomRoot : '/api/v3/workspaces/1/items/2000', partNumber : 'B', quantity : 4, isProcess : false },
        { level : 1, link : '/api/v3/workspaces/1/items/502', quantity : 1, isProcess : true },
        { level : 2, link : '/api/v3/workspaces/1/items/101', ebomRoot : '/api/v3/workspaces/1/items/1000', partNumber : 'A', quantity : 6, isProcess : false }
    ];
    const actual = {};
    context.manufacturingParts = manufacturingParts;
    context.actual = actual;
    await vm.runInContext(
        'aggregateHolisticMBOMParts(manufacturingParts, 0, 1, actual, new Set(), [])',
        context
    );

    assert.strictEqual(actual['/api/v3/workspaces/1/items/1000'].quantity, 6);
    assert.strictEqual(actual['/api/v3/workspaces/1/items/2000'].quantity, 4);

    context.fetchHolisticMBOMParts = async function(link) {
        assert.strictEqual(link, '/api/v3/workspaces/1/items/110');
        return [
            { level : 0, link : '/api/v3/workspaces/1/items/110', quantity : 0 },
            { level : 1, link : '/api/v3/workspaces/1/items/111', quantity : 1, isProcess : true },
            { level : 2, link : '/api/v3/workspaces/1/items/101', ebomRoot : '/api/v3/workspaces/1/items/1000', partNumber : 'A', quantity : 3, isProcess : false }
        ];
    };
    context.nestedManufacturingParts = [
        { level : 0, link : '/api/v3/workspaces/1/items/500', quantity : 0 },
        {
            level     : 1,
            link      : '/api/v3/workspaces/1/items/110',
            quantity  : 2,
            ebom      : { link : '/api/v3/workspaces/1/items/10' },
            type      : 'Manufacturing',
            isProcess : false
        }
    ];
    context.nestedActual = {};
    await vm.runInContext(
        'aggregateHolisticMBOMParts(nestedManufacturingParts, 0, 1, nestedActual, new Set(), [])',
        context
    );
    assert.strictEqual(context.nestedActual['/api/v3/workspaces/1/items/1000'].quantity, 6);

    assert.strictEqual(vm.runInContext(
        "isHolisticExpandableMBOMPart({ type: 'Mechanical', ebom: { link: '/api/v3/workspaces/1/items/100' } })",
        context
    ), false);
    assert.strictEqual(vm.runInContext(
        "isHolisticExpandableMBOMPart({ type: 'Manufacturing', ebom: { link: '/api/v3/workspaces/1/items/10' } })",
        context
    ), true);

    context.expected = expected;
    context.actual = actual;
    assert.strictEqual(vm.runInContext("getHolisticComparisonState(expected, actual, '/api/v3/workspaces/1/items/1000')", context), 'match');

    actual['/api/v3/workspaces/1/items/1000'].quantity = 5;
    assert.strictEqual(vm.runInContext("getHolisticComparisonState(expected, actual, '/api/v3/workspaces/1/items/1000')", context), 'different');

    actual['/api/v3/workspaces/1/items/999'] = { quantity : 1, partNumbers : ['EXTRA'] };
    assert.strictEqual(vm.runInContext("getHolisticComparisonState(expected, actual, '/api/v3/workspaces/1/items/999')", context), 'additional');

    function createStatusElement(classes) {
        return {
            classes : new Set(classes || []),
            removeClass(value) {
                String(value).split(/\s+/).forEach((name) => this.classes.delete(name));
                return this;
            },
            addClass(value) {
                String(value).split(/\s+/).forEach((name) => this.classes.add(name));
                return this;
            }
        };
    }

    context.rollupElement = createStatusElement(['different-qty']);
    vm.runInContext("setHolisticItemState(rollupElement, 'different')", context);
    assert.strictEqual(context.rollupElement.classes.has('different'), true);
    assert.strictEqual(context.rollupElement.classes.has('different-qty'), false);

    context.directMismatchElement = createStatusElement();
    vm.runInContext("setHolisticItemState(directMismatchElement, 'different', true)", context);
    assert.strictEqual(context.directMismatchElement.classes.has('different'), true);
    assert.strictEqual(context.directMismatchElement.classes.has('different-qty'), true);

    function createLinkElement(attributes) {
        return {
            length : 1,
            attr(name) {
                return attributes[name];
            }
        };
    }

    context.apiLinkElement = createLinkElement({
        'data-link-mbom' : '/api/v3/workspaces/57/items/19466'
    });
    assert.strictEqual(
        vm.runInContext('getMBOMChildSaveLink(apiLinkElement)', context),
        '/api/v3/workspaces/57/items/19466'
    );

    context.urnLinkElement = createLinkElement({
        'data-link-mbom' : 'urn:adsk.plm:tenant.workspace.item:TENANT.57.19466'
    });
    assert.strictEqual(
        vm.runInContext('getMBOMSaveLink(urnLinkElement)', context),
        '/api/v3/workspaces/57/items/19466'
    );

    console.log('Holistic mBOM comparison tests passed.');
}

run().catch(function(error) {
    console.error(error);
    process.exitCode = 1;
});
