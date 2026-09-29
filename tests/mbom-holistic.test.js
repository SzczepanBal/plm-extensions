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
    assert.strictEqual(vm.runInContext("getValidatedRawMaterialInsertQuantity('2,5', 'kg', 'Meter')", context), 2.5);
    assert.strictEqual(vm.runInContext("getValidatedRawMaterialInsertQuantity('2,5', '', 'kg')", context), 2.5);
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

async function testRawMaterialCreation() {
    const rawContext = {
        console, Promise,
        rawMaterialsWorkspaceId: 57,
        rawMaterialTypeName: 'Surowiec',
        rawMaterialCreationPromises: {},
        rawMaterialSearchPromises: {},
        isBlank: context.isBlank
    };
    const expected = {
        GRUPA_PRODUKTOWA: 'RAW-GROUP', NUMBER: '', TITLE: 'Steel', NAZWA: 'Steel',
        NAZWA_DEFRO: 'Steel', TYPE: 'Surowiec', TYP_CZESCI: 'S',
        RODZAJ: 'Surowiec', WARIANT: 'Surowiec', SPECYFIKACJA: 'Surowiec'
    };
    const dropdowns = ['TYPE'];
    let posts = [];
    rawContext.$ = {
        get(url, params) {
            if(url === '/plm/sections') return Promise.resolve({ data: [] });
            if(url === '/plm/fields') return Promise.resolve({ data: Object.keys(expected).map(fieldId => ({
                __self__: '/fields/' + fieldId,
                picklist: dropdowns.includes(fieldId) ? '/lookups/' + fieldId : null
            })) });
            assert.strictEqual(url, '/plm/picklist');
            const fieldId = params.link.split('/').pop();
            assert.ok(dropdowns.includes(fieldId));
            return Promise.resolve({ data: { items: [{ title: expected[fieldId], link: '/options/' + fieldId }] } });
        },
        post(params) {
            posts.push(JSON.parse(params.data));
            return Promise.resolve({ data: '/api/v3/workspaces/57/items/123' });
        }
    };
    vm.createContext(rawContext);
    ['normalizeComparisonValue', 'createRawMaterialItem', 'ensureRawMaterialSearchResult', 'getRawMaterialErrorMessage', 'resolveRawMaterialForBatch'].forEach(name => {
        vm.runInContext(extractFunction(name), rawContext);
    });
    const missing = { material: 'Steel', items: [] };
    const results = await Promise.all([
        rawContext.ensureRawMaterialSearchResult(missing, 'RAW-GROUP'),
        rawContext.ensureRawMaterialSearchResult({ material: ' steel ', items: [] }, 'RAW-GROUP')
    ]);
    assert.strictEqual(posts.length, 1, 'Repeated materials must reuse one creation');
    assert.strictEqual(results[0].items[0].__self__, '/api/v3/workspaces/57/items/123');
    assert.strictEqual(posts[0].wsId, 57);
    assert.deepStrictEqual(Object.fromEntries(posts[0].fields.map(field => [field.fieldId, field.value])), {
        ...expected, ...Object.fromEntries(dropdowns.map(fieldId => [fieldId, { link: '/options/' + fieldId }]))
    });
    assert.throws(() => rawContext.ensureRawMaterialSearchResult({ ...missing, error: true }), /nie powiodło się/);
    const existing = { material: 'Other', items: [{ title: 'Other' }] };
    assert.strictEqual(await rawContext.ensureRawMaterialSearchResult(existing), existing);
    assert.strictEqual(posts.length, 1);
    const originalGet = rawContext.$.get;
    rawContext.config = { mbomRoot: { typeValue: '/lookups/TYPE/options/manufacturing' } };
    rawContext.$.get = async (url, params) => {
        const response = await originalGet(url, params);
        if(url === '/plm/fields') response.data.forEach(field => { delete field.picklist; });
        return response;
    };
    await rawContext.createRawMaterialItem('Steel', 'RAW-GROUP');
    assert.deepStrictEqual(posts.pop().fields.find(field => field.fieldId === 'TYPE').value,
        { link: '/options/TYPE' }, 'TYPE must resolve through the MBOM lookup even without picklist metadata');
    rawContext.$.get = originalGet;
    const originalPost = rawContext.$.post;
    rawContext.$.post = () => Promise.resolve({ error: true, message: 'Required field is missing', status: 400 });
    rawContext.searchRawMaterialItems = material => Promise.resolve(
        material === 'Other' ? existing : { material, items: [] }
    );
    const batch = await Promise.all([
        rawContext.resolveRawMaterialForBatch('Rejected material', true, 'RAW-GROUP'),
        rawContext.resolveRawMaterialForBatch('Other')
    ]);
    assert.strictEqual(batch[0].error, true);
    assert.match(batch[0].message, /Required field is missing/);
    assert.strictEqual(batch[1], existing, 'A rejected creation must not abort successful material lookups');
    assert.strictEqual(rawContext.rawMaterialCreationPromises['rejected material'], undefined);
    assert.strictEqual(rawContext.rawMaterialSearchPromises['rejected material'], undefined);
    rawContext.$.post = originalPost;
    assert.strictEqual((await rawContext.resolveRawMaterialForBatch('Rejected material', true, 'RAW-GROUP')).items.length, 1,
        'A failed material can be retried');
    rawContext.searchRawMaterialItems = () => Promise.reject({ responseJSON: { message: 'Search unavailable' } });
    const failedSearch = await rawContext.resolveRawMaterialForBatch('Search failure');
    assert.strictEqual(failedSearch.message, 'Search unavailable');
    assert.strictEqual(posts.length, 2, 'A failed search must not create an item');
    console.log('Raw material creation tests passed');
}
testRawMaterialCreation().catch(error => { console.error(error); process.exitCode = 1; });

async function testRawMaterialUnitWarning() {
    const warnings = [];
    const unitContext = {
        console: { log() {}, warn(...args) { warnings.push(args); } },
        resolveRawMaterialUnitOfMeasure: () => Promise.resolve('Meter'),
        getPartItemLink: () => '/items/1', getPartNumber: () => 'Part',
        getSearchItemLink: () => '/items/2',
        rawMaterialUnitsMatch: context.rawMaterialUnitsMatch,
        getValidatedRawMaterialInsertQuantity: context.getValidatedRawMaterialInsertQuantity
    };
    vm.createContext(unitContext);
    vm.runInContext(extractFunction('getRawMaterialInsertQuantity'), unitContext);
    const entry = { accountingUnit: 'kg', accountingQuantity: 2.5, material: 'Steel' };
    assert.strictEqual(await unitContext.getRawMaterialInsertQuantity(entry, {}), 2.5);
    assert.ok(entry.uomMismatch);
    assert.strictEqual(warnings.length, 1, 'Mismatched units warn without skipping insertion');
    entry.accountingQuantity = NaN;
    assert.ok(Number.isNaN(await unitContext.getRawMaterialInsertQuantity(entry, {})),
        'Missing quantity must still be rejected');
    console.log('Raw material unit warning tests passed');
}
testRawMaterialUnitWarning().catch(error => { console.error(error); process.exitCode = 1; });

(async function testMBOMCreationCopiesAccountingFields() {
    let payload;
    const configuredMappings = require('../settings/custom').applications.mbom.mbomRoot.fieldsToCopy;
    const copyContext = {
        rawMaterialAccountingUnitFieldId: 'JEDNOSTKA_ROZLICZENIOWA',
        rawMaterialAccountingQuantityFieldId: 'ILOSC_ROZLICZENIOWA',
        isBlank: context.isBlank,
        getSectionFieldValue(sections, fieldId) { return sections[fieldId]; },
        config: {
            mbomRoot: { fieldsToCopy: configuredMappings.map(mapping => ({ ...mapping })) },
            workspaceMBOM: { fieldIDs: { ebom: 'EBOM', ebomRoot: 'EBOM_ROOT', lastMBOMSync: 'SYNC', lastMBOMUser: 'USER' } }
        },
        getSourceEBOMHasChildren: async () => true,
        wsMBOM: { wsId: 57, sections: [] }, userAccount: { displayName: 'Test' },
        $: { post(params) { payload = JSON.parse(params.data); } }
    };
    vm.createContext(copyContext);
    ['getMBOMPropertyRepairMappings', 'buildMBOMPropertyRepairFields', 'createMBOMForEBOM'].forEach(name => {
        vm.runInContext(extractFunction(name), copyContext);
    });
    const source = {
        __self__: '/items/ebom', root: { link: '/items/root' },
        sections: {
            TITLE: 'Part',
            INDEKS_CZESCI: 'ERP-4711',
            JEDNOSTKA_ROZLICZENIOWA: '/api/v3/lookups/units/options/kg',
            ILOSC_ROZLICZENIOWA: 2.5,
            GRUPA_PRODUKTOWA_SUROWCOW: 'RAW-GROUP'
        }
    };
    await copyContext.createMBOMForEBOM(source, '');
    assert.strictEqual(payload.fields.find(f => f.fieldId === 'HAS_BOM').value, true);
    assert.strictEqual(payload.fields.find(f => f.fieldId === 'JEDNOSTKA_ROZLICZENIOWA').value,
        source.sections.JEDNOSTKA_ROZLICZENIOWA);
    assert.strictEqual(payload.fields.find(f => f.fieldId === 'ILOSC_ROZLICZENIOWA').value, 2.5);
    assert.strictEqual(payload.fields.find(f => f.fieldId === 'INDEKS_CZESCI').value, 'ERP-4711',
        'New mBOMs copy the ERP part index from their source eBOM');
    assert.strictEqual(payload.fields.find(f => f.fieldId === 'GRUPA_PRODUKTOWA_SUROWCOW').value, 'RAW-GROUP',
        'New mBOMs copy the raw-material product group from their source eBOM');
    const repairFields = copyContext.buildMBOMPropertyRepairFields(
        source.sections,
        copyContext.getMBOMPropertyRepairMappings()
    );
    assert.strictEqual(repairFields.find(f => f.fieldId === 'INDEKS_CZESCI').value, 'ERP-4711',
        'Repair mBOM properties copies the ERP part index too');
    assert.deepStrictEqual(copyContext.config.mbomRoot.fieldsToCopy, configuredMappings, 'Do not mutate configured mappings');
    await copyContext.createMBOMForEBOM(source, '');
    assert.strictEqual(payload.fields.filter(f => f.fieldId === 'ILOSC_ROZLICZENIOWA').length, 1);
    copyContext.getSourceEBOMHasChildren = async () => false;
    delete copyContext.config.mbomRoot.fieldsToCopy;
    await copyContext.createMBOMForEBOM(source, '');
    assert.strictEqual(payload.fields.some(f => f.fieldId === 'ILOSC_ROZLICZENIOWA'), false,
        'Fields must come only from the configured copy list');
    assert.strictEqual(payload.fields.find(f => f.fieldId === 'HAS_BOM').value, false);
    console.log('MBOM accounting field creation tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

(function testERPProductAndTechnologyMarkers() {
    const markerContext = {
        Promise,
        isBlank: context.isBlank,
        getSectionFieldValue: context.getSectionFieldValue,
        config: { workspaceMBOM: { fieldIDs: { erpVersionId: 'ID_WERSJI' } } },
        getERPTechnologySectionValue(sections, candidateIds, fallbackValue) {
            for(const fieldId of candidateIds) {
                if(Object.prototype.hasOwnProperty.call(sections, fieldId)) return String(sections[fieldId]);
            }
            return fallbackValue;
        },
        isERPTechnologyMainRootItem: () => false,
        getERPTechnologyStoredPartIndex: (itemPart, detailsData) => detailsData.partIndex || ''
    };
    vm.createContext(markerContext);
    ['normalizeERPBooleanText', 'isERPProductSynced', 'isERPTechnologySynced', 'needsERPSubMBOMProduct', 'buildERPAddProductName'].forEach(name => {
        vm.runInContext(extractFunction(name), markerContext);
    });

    const subMBOMElement = { length: 1 };
    assert.strictEqual(markerContext.isERPTechnologySynced({ sections: {} }), false);
    assert.strictEqual(markerContext.isERPTechnologySynced({ sections: { ID_WERSJI: 4711 } }), true,
        'ID_WERSJI marks an mBOM technology as already sent');
    assert.strictEqual(markerContext.isERPProductSynced({
        sections: [{ fields: [{ id: 'WYSLANE_DO_ERP', value: true }] }]
    }), true, 'WYSLANE_DO_ERP marks the linked eBOM product as already sent');
    assert.strictEqual(markerContext.needsERPSubMBOMProduct(subMBOMElement, {}, { partIndex: '' }), true,
        'A missing INDEKS_CZESCI requires add-product');
    assert.strictEqual(markerContext.needsERPSubMBOMProduct(subMBOMElement, {}, { partIndex: 'ERP-4711' }), false,
        'INDEKS_CZESCI proves that the ERP product already exists');
    assert.strictEqual(markerContext.buildERPAddProductName({ OPIS: 'Description', NAZWA_DEFRO: 'Defro name' }, 'Title', '100'),
        'Description - Defro name');
    assert.strictEqual(markerContext.buildERPAddProductName({ OPIS: '', NAZWA_DEFRO: 'Defro name' }, 'Title', '100'),
        'Defro name');
    assert.strictEqual(markerContext.buildERPAddProductName({}, 'Title', '100'), 'Title');
    console.log('ERP product and technology marker tests passed');
})();

(async function testERPProductPrerequisiteUsesEBOM() {
    let ebomDetails = {
        partIndex: 'ERP-4711',
        sections: [{ fields: [{ id: 'WYSLANE_DO_ERP', value: true }] }]
    };
    let payloadDetails = null;
    const prerequisiteContext = {
        Promise,
        isBlank: context.isBlank,
        needsERPSubMBOMProduct: (elemItem, itemPart, detailsData) => !detailsData.partIndex,
        buildERPAssemblyIndexProductPayload: () => ({ assembly: true }),
        getERPTechnologyElementLink: () => '/mbom',
        getERPTechnologyEBOMLink: () => '/ebom',
        getERPTechnologyItemDetails: async () => ebomDetails,
        getERPTechnologyStoredPartIndex: (itemPart, detailsData) => detailsData.partIndex || '',
        isERPProductSynced: detailsData => detailsData.sections[0].fields[0].value === true,
        buildERPSubMBOMProductPayload: (elemItem, itemPart, detailsData) => {
            payloadDetails = detailsData;
            return { source: 'ebom' };
        }
    };
    vm.createContext(prerequisiteContext);
    vm.runInContext(extractFunction('resolveERPProductPrerequisite'), prerequisiteContext);

    const elemItem = { length: 1 };
    let state = await prerequisiteContext.resolveERPProductPrerequisite(elemItem, {}, { partIndex: 'ERP-1' }, false, false);
    assert.strictEqual(state.required, false, 'A copied mBOM ERP index avoids the linked eBOM request');

    state = await prerequisiteContext.resolveERPProductPrerequisite(elemItem, {}, { partIndex: '' }, false, false);
    assert.strictEqual(state.required, false, 'An already sent eBOM avoids add-product');
    assert.strictEqual(state.indexToCopy, 'ERP-4711');

    ebomDetails = {
        partIndex: '',
        sections: [{ fields: [{ id: 'WYSLANE_DO_ERP', value: false }] }]
    };
    state = await prerequisiteContext.resolveERPProductPrerequisite(elemItem, {}, { partIndex: '' }, false, false);
    assert.strictEqual(state.required, true, 'An unsent eBOM requires add-product');
    assert.strictEqual(state.sourceLink, '/ebom');
    assert.strictEqual(state.payload.source, 'ebom');
    assert.strictEqual(payloadDetails, ebomDetails, 'The add-product payload is built from eBOM details');
    console.log('ERP eBOM product prerequisite tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

(function testRawMaterialScopeReportAndConfirmation() {
    const handlers = {};
    const starts = [];
    const reportContext = {
        tenant: 'TEST',
        rawMaterialApplyModes: {
            addMissing: 'add-missing', updateQuantity: 'update-quantity', overwrite: 'overwrite'
        },
        getPartItemLink: part => part.link,
        getPartNumber: part => part.number,
        startRawMaterialsFromMBOM: mode => { starts.push(mode); },
        $(selector) {
            return {
                hasClass: () => false, show() { return this; }, hide() { return this; },
                off() { return this; }, on(event, handler) { handlers[selector] = handler; return this; },
                trigger() { return this; }
            };
        }
    };
    vm.createContext(reportContext);
    ['getRawMaterialReportRows', 'addRawMaterialsFromMBOM'].forEach(name => {
        vm.runInContext(extractFunction(name), reportContext);
    });
    const rows = reportContext.getRawMaterialReportRows([{
        part: { link: '/api/v3/workspaces/57/items/21675', number: 'P00000473-M' },
        material: '', rawMaterialMessage: 'Pole MATERIAL jest puste.',
        uomMismatch: { mbomUnit: 'kg', rawMaterialUOM: 'm' }
    }]);
    assert.strictEqual(rows[0].outcome, 'not-added');
    assert.strictEqual(rows[0].message, 'Pole MATERIAL jest puste.');
    assert.ok(rows[0].href.startsWith('https://TEST.autodeskplm360.net/plm/workspaces/57/items/itemDetails?'));
    assert.ok(rows[0].href.endsWith('TEST%2C57%2C21675'));
    assert.match(rows[0].warnings[0], /bez przeliczenia/);
    reportContext.addRawMaterialsFromMBOM();
    assert.strictEqual(starts.length, 0, 'Opening confirmation must not start processing');
    handlers['#cancel-add-raw-materials']();
    assert.strictEqual(starts.length, 0, 'Cancel must not start processing');
    reportContext.addRawMaterialsFromMBOM();
    handlers['#start-add-missing-raw-materials']();
    handlers['#start-update-raw-material-quantities']();
    handlers['#start-overwrite-raw-materials']();
    assert.deepStrictEqual(starts, ['add-missing', 'update-quantity', 'overwrite']);
    console.log('Raw material scope, report and confirmation tests passed');
})();

async function testRecursiveRawMaterialDiscovery() {
    const parts = [
        { link: '/root', level: 0, mbom: true },
        { link: '/operation', level: 1, mbom: false },
        { link: '/sub', level: 2, mbom: true }
    ];
    let expanded = [];
    let visible = [{ link: '/sub', attr: () => 'true' }];
    const traversalContext = {
        Set, isBlank: context.isBlank,
        inlineSubMBOMBulkExpansionActive: false,
        normalizePLMLink: value => value,
        getPartItemLink: part => part.link,
        getMBOMItemForPart: part => part,
        isMBOMTechnologyItem: part => part.mbom,
        getERPTechnologyExpandableItems: () => visible,
        getERPTechnologyElementLink: item => item.link,
        $: () => ({ show() {} }),
        updateMBOMNumbers() {},
        setStatusBar() {},
        async ensureInlineSubMBOMExpanded(item) {
            expanded.push(item.link);
            if(item.link === '/sub') {
                parts.push({ link: '/nested-operation', level: 3, mbom: false });
                parts.push({ link: '/subsub', level: 4, mbom: true });
                visible.push({ link: '/subsub', attr: () => 'true' });
            }
            if(item.link === '/subsub') {
                parts.push({ link: '/subsubsub', level: 6, mbom: true });
                visible.push({ link: '/subsubsub', attr: () => 'true' });
                visible.push({ link: '/sub', attr: () => 'true' });
            }
            return true;
        }
    };
    vm.createContext(traversalContext);
    ['ensureRawMaterialTreeExpanded', 'getRawMaterialSourceParts'].forEach(name => {
        vm.runInContext(extractFunction(name), traversalContext);
    });
    await traversalContext.ensureRawMaterialTreeExpanded();
    assert.deepStrictEqual(expanded, ['/sub', '/subsub', '/subsubsub'], 'Discover newly expanded levels and stop revisiting links');
    const selected = traversalContext.getRawMaterialSourceParts(parts.concat(parts));
    assert.deepStrictEqual(Array.from(selected, part => part.link), ['/root', '/sub', '/subsub', '/subsubsub'],
        'Include MBOMs through operation levels, exclude operations, and deduplicate shared MBOMs');
    visible = [{ link: '/failed', attr: () => undefined }];
    traversalContext.ensureInlineSubMBOMExpanded = async () => false;
    await assert.rejects(traversalContext.ensureRawMaterialTreeExpanded(), /Could not discover all nested MBOMs/);

    let activeExpansions = 0;
    let maximumActiveExpansions = 0;
    visible = Array.from({ length: 14 }, (_, index) => ({ link: '/parallel-' + index, attr: () => 'true' }));
    traversalContext.ensureInlineSubMBOMExpanded = async () => {
        activeExpansions++;
        maximumActiveExpansions = Math.max(maximumActiveExpansions, activeExpansions);
        await new Promise(resolve => setTimeout(resolve, 2));
        activeExpansions--;
        return true;
    };
    await traversalContext.ensureRawMaterialTreeExpanded();
    assert.strictEqual(maximumActiveExpansions, 6, 'Expand linked MBOMs with six bounded workers');
    console.log('Recursive raw material discovery tests passed');
}
testRecursiveRawMaterialDiscovery().catch(error => { console.error(error); process.exitCode = 1; });

async function testHasBOMMarker() {
    let parts = [{ level: 0 }, { level: 1 }];
    const markerContext = {
        wsEBOM: { viewId: 5 },
        getRawMaterialErrorMessage: () => 'Read failed',
        $: { get(url, params) {
            assert.strictEqual(url, '/plm/bom');
            assert.strictEqual(params.depth, 1);
            return Promise.resolve({ data: { bomPartsList: parts } });
        } }
    };
    vm.createContext(markerContext);
    ['getSourceEBOMHasChildren', 'isMBOMHasBOM', 'getRawMaterialSkipReason'].forEach(name => {
        vm.runInContext(extractFunction(name), markerContext);
    });
    assert.strictEqual(await markerContext.getSourceEBOMHasChildren({ __self__: '/ebom' }), true);
    parts = [{ level: 0 }];
    assert.strictEqual(await markerContext.getSourceEBOMHasChildren({ __self__: '/ebom' }), false);
    assert.strictEqual(markerContext.isMBOMHasBOM('true'), true);
    assert.strictEqual(markerContext.isMBOMHasBOM('false'), false);
    assert.strictEqual(markerContext.isMBOMHasBOM(undefined), false);
    assert.match(markerContext.getRawMaterialSkipReason({ hasBom: true }), /HAS_BOM/);
    assert.strictEqual(markerContext.getRawMaterialSkipReason({ hasBom: false }), '');
    assert.match(markerContext.getRawMaterialSkipReason({ detailsError: true }), /nie można sprawdzić/);
    console.log('HAS_BOM marker tests passed');
}
testHasBOMMarker().catch(error => { console.error(error); process.exitCode = 1; });

async function testRepairRefreshesHasBOM() {
    let hasChildren = true;
    let validTarget = true;
    const writes = [];
    const repairContext = {
        console: { info() {} },
        isBlank: context.isBlank,
        wsMBOM: { sections: [] },
        getPLMItemLevelLink: link => link,
        normalizePLMLink: link => link,
        getConfiguredMBOMLinkFromDetails: () => '/mbom',
        isMBOMPropertyRepairTarget: () => validTarget,
        loadMBOMPropertyRepairDetails: async link => ({ __self__: link, sections: [] }),
        getSourceEBOMHasChildren: async details => {
            assert.strictEqual(details.__self__, '/ebom');
            return hasChildren;
        },
        buildMBOMPropertyRepairFields: () => [{ fieldId: 'HAS_BOM', value: 'stale' }],
        $: { post: async (url, payload) => { writes.push({ url, payload }); return {}; } }
    };
    vm.createContext(repairContext);
    vm.runInContext(extractFunction('repairMBOMPropertiesFromEBOM'), repairContext);
    const results = { updated: 0, skipped: 0 };
    await repairContext.repairMBOMPropertiesFromEBOM('/ebom', [], results);
    assert.strictEqual(writes[0].payload.link, '/mbom');
    assert.strictEqual(writes[0].payload.fields.length, 1);
    assert.strictEqual(writes[0].payload.fields[0].value, true);
    hasChildren = false;
    repairContext.buildMBOMPropertyRepairFields = () => [];
    await repairContext.repairMBOMPropertiesFromEBOM('/ebom', [], results);
    assert.strictEqual(writes[1].payload.fields[0].value, false, 'Repair clears stale HAS_BOM for leaf EBOMs');
    assert.strictEqual(results.updated, 2);
    validTarget = false;
    await assert.rejects(repairContext.repairMBOMPropertiesFromEBOM('/ebom', [], results), /Safety check/);
    assert.strictEqual(writes.length, 2, 'Keep target verification before writes');
    validTarget = true;
    repairContext.getSourceEBOMHasChildren = async () => { throw new Error('BOM read failed'); };
    await assert.rejects(repairContext.repairMBOMPropertiesFromEBOM('/ebom', [], results), /BOM read failed/);
    assert.strictEqual(writes.length, 2, 'Do not set HAS_BOM false after a failed BOM read');
    console.log('Repair HAS_BOM tests passed');
}
testRepairRefreshesHasBOM().catch(error => { console.error(error); process.exitCode = 1; });

(function testExistingLinkedMBOMInsertionAndMissingState() {
    let branchAttached = true;
    let leaf = false;
    const branch = {};
    const source = {
        children() { return { detach() { branchAttached = false; return branch; } }; },
        hasClass: () => leaf,
        addClass() { leaf = true; return this; },
        toggleClass(name, value) { leaf = value; return this; },
        append(value) { assert.strictEqual(value, branch); branchAttached = true; }
    };
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(extractFunction('insertLinkedMBOMWithoutEBOMChildren'), ctx);
    const action = { closest: () => source };
    ctx.insertLinkedMBOMWithoutEBOMChildren(action, received => {
        assert.strictEqual(received, action);
        assert.strictEqual(branchAttached, false, 'Do not clone engineering children into the MBOM');
        assert.strictEqual(leaf, true);
    });
    assert.strictEqual(branchAttached, true);
    assert.strictEqual(leaf, false, 'Keep source EBOM expandable');
    assert.throws(() => ctx.insertLinkedMBOMWithoutEBOMChildren(action, () => { throw new Error('insert failed'); }), /insert failed/);
    assert.strictEqual(branchAttached, true, 'Restore source branch after insertion failure');
    let present = false;
    let pending;
    let state;
    let missing;
    let addActionRemoved = false;
    const row = {
        hasClass: () => false,
        toggleClass(name, value) { missing = value; },
        children() { return this; },
        attr() { return this; },
        remove() { addActionRemoved = true; }
    };
    Object.assign(ctx, {
        isBlank: context.isBlank,
        $(value) { return value === '#ebom' ? { find: () => ({ each: cb => cb.call(row) }) } : value; },
        getLinkedMBOMLinkFromEBOMElement: () => '/api/v3/workspaces/57/items/123',
        findLinkedMBOMItemForEBOM: () => ({ length: present ? 1 : 0 }),
        addLinkedMBOMInsertAction() {},
        setLinkedEBOMBOMCheckPending(item, value) { pending = value; },
        setHolisticItemState(item, value) { state = value; }
    });
    vm.runInContext(extractFunction('refreshMissingLinkedMBOMStatus'), ctx);
    ctx.refreshMissingLinkedMBOMStatus();
    assert.strictEqual(missing, true);
    assert.strictEqual(state, 'additional', 'Linked MBOM absent from parent must be red');
    assert.strictEqual(pending, false, 'Missing item must not remain gray awaiting expansion');
    present = true;
    state = 'match';
    ctx.refreshMissingLinkedMBOMStatus();
    assert.strictEqual(missing, false);
    assert.strictEqual(addActionRemoved, true, 'Remove stale Add MBOM action after nested MBOM is found');
    assert.strictEqual(state, 'match', 'Do not override comparison status when linked MBOM is present');
    console.log('Existing linked MBOM insertion and status tests passed');
})();

async function testSaveMBOMHasBOMMarker() {
    let savedMarker = null;
    let hasChildren = true;
    let validTarget = true;
    let rejectWrite = false;
    let writes = [];
    const saveContext = {
        isBlank: context.isBlank,
        wsMBOM: { sections: [] },
        loadMBOMPropertyRepairDetails: async link => ({ __self__: link }),
        getSectionFieldValue: () => savedMarker,
        isMBOMHasBOM: value => value === true || value === 'true',
        getMBOMPropertyRepairSourceLink: () => '/ebom',
        isMBOMPropertyRepairTarget: () => validTarget,
        getSourceEBOMHasChildren: async details => {
            assert.strictEqual(details.__self__, '/ebom');
            return hasChildren;
        },
        getRawMaterialErrorMessage: () => 'Rejected',
        $: { post: async (url, payload) => {
            writes.push(payload);
            return { error: rejectWrite };
        } }
    };
    vm.createContext(saveContext);
    vm.runInContext(extractFunction('saveMBOMHasBOMMarker'), saveContext);
    await saveContext.saveMBOMHasBOMMarker('/mbom');
    assert.strictEqual(writes[0].fields[0].fieldId, 'HAS_BOM');
    assert.strictEqual(writes[0].fields[0].value, true);
    hasChildren = false;
    await saveContext.saveMBOMHasBOMMarker('/mbom');
    assert.strictEqual(writes[1].fields[0].value, false);
    savedMarker = false;
    await saveContext.saveMBOMHasBOMMarker('/mbom');
    assert.strictEqual(writes.length, 2, 'Unchanged HAS_BOM must not be written again');
    savedMarker = null;
    validTarget = false;
    await saveContext.saveMBOMHasBOMMarker('/non-manufacturing');
    assert.strictEqual(writes.length, 2);
    validTarget = true;
    rejectWrite = true;
    await assert.rejects(saveContext.saveMBOMHasBOMMarker('/mbom'), /Could not save HAS_BOM/);
    console.log('Save MBOM HAS_BOM tests passed');
}
testSaveMBOMHasBOMMarker().catch(error => { console.error(error); process.exitCode = 1; });

(function testInlineOperationDeduplication() {
    let rows = [];
    const dedupContext = {
        isBlank: context.isBlank, normalizePLMLink: value => value || '',
        $: value => value || { length: 0 }
    };
    vm.createContext(dedupContext);
    vm.runInContext(extractFunction('findMatchingDirectInlineChild'), dedupContext);
    const parent = { length: 1, children: () => ({ each(callback) {
        for(const row of rows) if(callback.call(row) === false) break;
    } }) };
    const row = attrs => ({ length: 1, attr: key => attrs[key] });
    const existing = row({ 'data-edge': '123', 'data-link': '/operation', 'data-number-db': '10' });
    rows = [existing];
    assert.strictEqual(dedupContext.findMatchingDirectInlineChild(parent,
        { edgeId: '123', link: '/operation', number: '20' }), existing,
        'Reuse the same edge even after its displayed number changes');
    assert.strictEqual(dedupContext.findMatchingDirectInlineChild(parent,
        { edgeId: '456', link: '/operation', number: '10' }).length, 0,
        'Keep distinct saved occurrences of the same operation');
    assert.strictEqual(dedupContext.findMatchingDirectInlineChild(parent,
        { link: '/operation', number: '10' }), existing,
        'Use item and position when one edge ID is unavailable');
    console.log('Inline operation deduplication tests passed');
})();

async function testRawMaterialSourceRefreshCaches() {
    let detailRequests = 0;
    const cacheContext = {
        Promise,
        Object,
        console,
        rawMaterialDetailsPromises: {},
        rawMaterialProductGroupFieldId: 'GRUPA_PRODUKTOWA_SUROWCOW',
        mbomPartsList: [{ link: '/mbom/1', root: '/root/1' }],
        normalizePLMLink: value => value || '',
        isBlank: context.isBlank,
        getPartItemLink: part => part.link,
        getPartNumber: part => part.number || '',
        isMBOMHasBOM: value => value === true,
        getSectionFieldValue: context.getSectionFieldValue,
        getMaterialValueFromItemDetails: () => 'S355',
        getMBOMAccountingUnitFromItemDetails: () => 'kg',
        getMBOMAccountingQuantityFromItemDetails: () => 2,
        $: {
            get() {
                detailRequests++;
                const deferred = {
                    done(callback) {
                        callback({ data: { sections: [] } });
                        return deferred;
                    },
                    fail() { return deferred; }
                };
                return deferred;
            }
        }
    };
    vm.createContext(cacheContext);
    ['fetchMBOMPartMaterialsFromDetails', 'getRawMaterialPartKey', 'mergeRawMaterialPartsIntoList']
        .forEach(name => vm.runInContext(extractFunction(name), cacheContext));

    const first = { link: '/mbom/2', root: '/root/2', number: '2' };
    const secondOccurrence = { link: '/mbom/2', root: '/root/3', number: '2' };
    const results = await cacheContext.fetchMBOMPartMaterialsFromDetails([first, first]);
    assert.strictEqual(detailRequests, 1, 'Fetch MBOM details once per normalized item link');
    assert.strictEqual(results[0].part, first);
    assert.strictEqual(results[1].material, 'S355');

    cacheContext.mergeRawMaterialPartsIntoList([first, first, secondOccurrence]);
    assert.strictEqual(cacheContext.mbomPartsList.length, 3,
        'Merge newly expanded MBOM occurrences while removing exact duplicates');
    console.log('Raw material source refresh cache tests passed');
}
testRawMaterialSourceRefreshCaches().catch(error => { console.error(error); process.exitCode = 1; });

(function testEmptyRawMaterialSourcesAreFiltered() {
    const filterContext = {
        Array,
        console: { log() {} },
        isBlank(value) {
            return value === null || typeof value === 'undefined' || String(value).trim() === '';
        }
    };
    vm.createContext(filterContext);
    vm.runInContext(extractFunction('filterRawMaterialEntriesWithMaterial'), filterContext);
    const filtered = filterContext.filterRawMaterialEntriesWithMaterial([
        { material: '' },
        { material: '   ' },
        { material: 'Steel' }
    ]);
    assert.deepStrictEqual(Array.from(filtered, entry => entry.material), ['Steel']);
    console.log('Empty raw material source filter tests passed');
})();

async function testBoundedERPPLMRequests() {
    const plmContext = {
        Promise,
        Array,
        Math,
        Number,
        erpTechnologyPLMActiveRequests: 0,
        erpTechnologyPLMRequestQueue: []
    };
    vm.createContext(plmContext);
    ['mapPLMRequestsWithConcurrency', 'runERPTechnologyPLMRequest']
        .forEach(name => vm.runInContext(extractFunction(name), plmContext));

    let activeMapped = 0;
    let maximumMapped = 0;
    const mapped = await plmContext.mapPLMRequestsWithConcurrency(
        Array.from({ length: 11 }, (_, index) => index),
        4,
        async value => {
            activeMapped++;
            maximumMapped = Math.max(maximumMapped, activeMapped);
            await new Promise(resolve => setTimeout(resolve, 2));
            activeMapped--;
            return value * 2;
        }
    );
    assert.strictEqual(maximumMapped, 4);
    assert.deepStrictEqual(Array.from(mapped), Array.from({ length: 11 }, (_, index) => index * 2),
        'Bounded PLM mapping must preserve source order');

    let activeRequests = 0;
    let maximumRequests = 0;
    await Promise.all(Array.from({ length: 14 }, () => plmContext.runERPTechnologyPLMRequest(async () => {
        activeRequests++;
        maximumRequests = Math.max(maximumRequests, activeRequests);
        await new Promise(resolve => setTimeout(resolve, 2));
        activeRequests--;
    })));
    assert.strictEqual(maximumRequests, 6, 'ERP payload preparation must limit PLM API requests to six');
    console.log('Bounded ERP PLM request tests passed');
}
testBoundedERPPLMRequests().catch(error => { console.error(error); process.exitCode = 1; });

async function testERPTechnologyDiscoveryUsesShallowDepth() {
    const requestedDepths = [];
    const item = { link: '/sub', attr() { return ''; } };
    const discoveryContext = {
        console: { log() {}, warn() {} },
        Promise, Set, Date,
        erpTechnologyDiscoveryDepth: 2,
        inlineSubMBOMBulkExpansionActive: false,
        isBlank: context.isBlank,
        getERPTechnologyExpandableItems: () => [item],
        getERPTechnologyElementLink: elemItem => elemItem.link,
        shouldExpandERPTechnologySubMBOM: async () => true,
        getERPTechnologyDescriptor: () => 'Sub MBOM',
        getElementLevel: () => 2,
        ensureInlineSubMBOMExpanded: async (elemItem, depth) => {
            requestedDepths.push(depth);
            return true;
        },
        updateMBOMNumbers() {},
        setStatusBar() {}
    };
    vm.createContext(discoveryContext);
    ['mapPLMRequestsWithConcurrency', 'ensureERPTechnologyTreeExpanded'].forEach(name => {
        vm.runInContext(extractFunction(name), discoveryContext);
    });

    await discoveryContext.ensureERPTechnologyTreeExpanded();
    assert.deepStrictEqual(requestedDepths, [2], 'ERP discovery loads only operation and component levels');
    assert.strictEqual(discoveryContext.inlineSubMBOMBulkExpansionActive, false);
    console.log('Shallow ERP technology discovery tests passed');
}
testERPTechnologyDiscoveryUsesShallowDepth().catch(error => { console.error(error); process.exitCode = 1; });
