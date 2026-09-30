const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourcePath = path.join(__dirname, '..', 'public', 'javascripts', 'custom', 'mbom.js');
const source = fs.readFileSync(sourcePath, 'utf8');

(function testFusionManageERPHashOnEditScript() {
    const scriptPath = path.join(__dirname, '..', 'docs', 'fusion-manage-erp-sync-on-edit.js');
    const script = fs.readFileSync(scriptPath, 'utf8');
    const synchronizedHash = 'v1:' + 'a'.repeat(64);

    const syncContext = { item: { ERP_HASH: 'pending:' + synchronizedHash, ERP_SYNC_STATUS: 'OUT_OF_DATE' }, Date };
    vm.runInNewContext(script, syncContext);
    assert.strictEqual(syncContext.item.ERP_HASH, synchronizedHash);
    assert.strictEqual(syncContext.item.ERP_SYNC_STATUS, 'UP_TO_DATE');
    assert.ok(syncContext.item.ERP_SYNC_DATE instanceof Date);

    const editContext = { item: { ERP_HASH: synchronizedHash, ERP_SYNC_STATUS: 'UP_TO_DATE' }, Date };
    vm.runInNewContext(script, editContext);
    assert.strictEqual(editContext.item.ERP_HASH, 'dirty:' + synchronizedHash);
    assert.strictEqual(editContext.item.ERP_SYNC_STATUS, 'OUT_OF_DATE');

    const newContext = { item: { ERP_HASH: '', ERP_SYNC_STATUS: '' }, Date };
    vm.runInNewContext(script, newContext);
    assert.strictEqual(newContext.item.ERP_HASH, 'dirty:new');
    assert.strictEqual(newContext.item.ERP_SYNC_STATUS, 'NOT_SYNCED');

    vm.runInNewContext(script, editContext);
    assert.strictEqual(editContext.item.ERP_HASH, 'dirty:' + synchronizedHash,
        'Repeated edits must not keep extending the dirty marker');
    console.log('Fusion Manage ERP hash onEdit tests passed');
})();

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
    ['normalizeComparisonValue', 'getSearchItemLink', 'getSearchItemFieldValue', 'itemLooksLikeMatchingRawMaterial',
        'getRawMaterialSearchProperty', 'isReleasedRawMaterialItem', 'getRawMaterialVersionOrder',
        'chooseRawMaterialItem', 'createRawMaterialItem', 'ensureRawMaterialSearchResult',
        'getRawMaterialErrorMessage', 'resolveRawMaterialForBatch'].forEach(name => {
        vm.runInContext(extractFunction(name), rawContext);
    });
    const missing = { material: 'Steel', items: [] };
    const results = await Promise.all([
        rawContext.ensureRawMaterialSearchResult(missing, 'RAW-GROUP'),
        rawContext.ensureRawMaterialSearchResult({ material: ' steel ', items: [] }, 'RAW-GROUP')
    ]);
    assert.strictEqual(posts.length, 1, 'Repeated materials must reuse one creation');
    assert.strictEqual(results[0].items.length, 0, 'A newly created working version must not be inserted into mBOM');
    assert.strictEqual(results[0].matchingItems[0].__self__, '/api/v3/workspaces/57/items/123');
    assert.strictEqual(results[0].unreleasedOnly, true);
    assert.strictEqual(posts[0].wsId, 57);
    assert.deepStrictEqual(Object.fromEntries(posts[0].fields.map(field => [field.fieldId, field.value])), {
        ...expected, ...Object.fromEntries(dropdowns.map(fieldId => [fieldId, { link: '/options/' + fieldId }]))
    });
    assert.throws(() => rawContext.ensureRawMaterialSearchResult({ ...missing, error: true }), /nie powiodło się/);
    const existing = { material: 'Other', items: [{ title: 'Other' }] };
    assert.strictEqual(await rawContext.ensureRawMaterialSearchResult(existing), existing);
    assert.strictEqual(posts.length, 1);
    const unreleasedMatch = { material: 'Steel', items: [], unreleasedOnly: true };
    assert.strictEqual(await rawContext.ensureRawMaterialSearchResult(unreleasedMatch, 'RAW-GROUP'), unreleasedMatch,
        'An unreleased match must warn instead of creating a duplicate raw material');
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
    const retriedCreation = await rawContext.resolveRawMaterialForBatch('Rejected material', true, 'RAW-GROUP');
    assert.strictEqual(retriedCreation.items.length, 0, 'A retried creation is still not released');
    assert.strictEqual(retriedCreation.created, true, 'A failed material can be retried');
    rawContext.searchRawMaterialItems = () => Promise.reject({ responseJSON: { message: 'Search unavailable' } });
    const failedSearch = await rawContext.resolveRawMaterialForBatch('Search failure');
    assert.strictEqual(failedSearch.message, 'Search unavailable');
    assert.strictEqual(posts.length, 2, 'A failed search must not create an item');

    const workingItem = {
        title: 'Steel', workingVersion: true,
        __self__: '/api/v3/workspaces/57/items/10/versions/3'
    };
    const releasedA = {
        title: 'Steel', workingVersion: false, versionId: 1,
        __self__: '/api/v3/workspaces/57/items/10/versions/1'
    };
    const releasedB = {
        title: 'Steel', workingVersion: false, versionId: 2,
        __self__: '/api/v3/workspaces/57/items/10/versions/2'
    };
    assert.strictEqual(rawContext.isReleasedRawMaterialItem(workingItem), false);
    assert.strictEqual(rawContext.isReleasedRawMaterialItem(releasedA), true);
    assert.strictEqual(rawContext.chooseRawMaterialItem('Steel', [workingItem, releasedA, releasedB]), releasedB,
        'The latest released version must be selected while the working version is ignored');
    assert.strictEqual(rawContext.chooseRawMaterialItem('Steel', [workingItem]), null,
        'A matching item with only a working version must not be selected');
    assert.strictEqual(rawContext.getSearchItemLink({
        __self__: '/api/v3/workspaces/57/items/10/versions/2',
        item: { link: '/api/v3/workspaces/57/items/10' }
    }), '/api/v3/workspaces/57/items/10/versions/2', 'Prefer the revision-specific search result link');
    assert.match(extractFunction('searchRawMaterialItems'), /revision\s*:\s*2/,
        'Raw-material search must request all revisions');
    console.log('Raw material creation tests passed');
}
testRawMaterialCreation().catch(error => { console.error(error); process.exitCode = 1; });

(function testRawMaterialVersionSpecificDOMMatching() {
    function makeRow(link) {
        return {
            length: 1,
            attr(name) {
                if(name === 'data-link') return link;
                return '';
            }
        };
    }
    const workingRow = makeRow('/api/v3/workspaces/57/items/10/versions/3');
    const releasedRow = makeRow('/api/v3/workspaces/57/items/10/versions/2');
    const rows = [workingRow, releasedRow];
    const empty = { length: 0 };
    const domContext = {
        isBlank: context.isBlank,
        $(value) { return typeof value === 'undefined' ? empty : value; }
    };
    const header = {
        length: 1,
        next() {
            return {
                children() {
                    return {
                        each(callback) {
                            for(const row of rows) {
                                if(callback.call(row) === false) break;
                            }
                        }
                    };
                }
            };
        }
    };
    vm.createContext(domContext);
    ['normalizePLMLink', 'normalizePLMVersionLink', 'getDirectChildItemByLink'].forEach(name => {
        vm.runInContext(extractFunction(name), domContext);
    });

    assert.strictEqual(domContext.getDirectChildItemByLink(
        header, '/api/v3/workspaces/57/items/10/versions/2'
    ), releasedRow, 'A released version link must select the released DOM row, not the working row');
    assert.strictEqual(domContext.getDirectChildItemByLink(
        header, '/api/v3/workspaces/57/items/10'
    ), workingRow, 'An item-level link retains the existing item-level fallback');
    console.log('Raw material version-specific DOM matching tests passed');
})();

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
        customERPFieldIDs: {
            versionId: 'ID_WERSJI',
            partIndex: 'INDEKS_CZESCI',
            syncDate: 'ERP_SYNC_DATE',
            syncStatus: 'ERP_SYNC_STATUS',
            hash: 'ERP_HASH'
        },
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
        customERPFieldIDs: {
            versionId: 'ID_WERSJI',
            partIndex: 'INDEKS_CZESCI',
            syncDate: 'ERP_SYNC_DATE',
            syncStatus: 'ERP_SYNC_STATUS',
            hash: 'ERP_HASH'
        },
        config: { workspaceMBOM: { fieldIDs: {} } },
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
    assert.strictEqual(markerContext.isERPTechnologySynced({
        sections: [{ fields: [{ id: 'ID_WERSJI', value: 4711 }] }]
    }), true, 'ID_WERSJI marks an mBOM technology as already created in ERP');
    assert.strictEqual(markerContext.isERPTechnologySynced({
        sections: [{ fields: [{ id: 'ID_WERSJI', value: 4711 }] }]
    }), true, 'ID_WERSJI marks an mBOM technology as already created in ERP');
    assert.strictEqual(markerContext.isERPProductSynced({
        sections: [{ fields: [{ id: 'INDEKS_CZESCI', value: 'ERP-4711' }] }]
    }), true, 'INDEKS_CZESCI marks a product as already created in ERP');
    assert.strictEqual(markerContext.needsERPSubMBOMProduct(subMBOMElement, {}, { partIndex: '' }), true,
        'A missing INDEKS_CZESCI requires add-product');
    assert.strictEqual(markerContext.needsERPSubMBOMProduct(subMBOMElement, {}, { partIndex: 'ERP-4711' }), false,
        'INDEKS_CZESCI proves that the ERP product already exists');
    assert.strictEqual(markerContext.buildERPAddProductName({ OPIS: 'Description', NAZWA_DEFRO: 'Defro name' }, 'Title', '100'),
        'Defro name');
    assert.strictEqual(markerContext.buildERPAddProductName({ OPIS: '', NAZWA_DEFRO: 'Defro name' }, 'Title', '100'),
        'Defro name');
    assert.strictEqual(markerContext.buildERPAddProductName({}, 'Title', '100'), 'Title');
    console.log('ERP product and technology marker tests passed');
})();

(async function testERPSyncUsesSingleBOMViewRequest() {
    let viewRequests = 0;
    let bomRequests = 0;
    const requiredDetails = {
        NUMBER: '1000',
        INDEKS_CZESCI: '1000',
        ID_WERSJI: 1,
        ERP_HASH: 'v1:abc',
        ERP_SYNC_STATUS: 'UP_TO_DATE',
        GRUPA_PRODUKTOWA: 'GROUP',
        TYPE: 'Manufacturing',
        PROCESS_CODE: null,
        KOD_OPERACJI: null
    };
    function jquery() {
        return { children() { return { first() { return {}; } }; } };
    }
    jquery.get = async (url, params) => {
        if(url === '/plm/bom-view-by-name') {
            viewRequests++;
            assert.strictEqual(params.name, 'ERP Sync');
            return { data: { id: 77, name: 'ERP Sync' } };
        }
        if(url === '/plm/bom') {
            bomRequests++;
            assert.strictEqual(params.viewId, 77);
            assert.strictEqual(params.depth, 10);
            assert.strictEqual(params.getBOMPartsList, true);
            return { data: { bomPartsList: [{ level: 0, link: '/mbom', details: requiredDetails }] } };
        }
        throw new Error('Unexpected request: ' + url);
    };
    const syncViewContext = {
        Promise,
        Object,
        Number,
        String,
        Array,
        $: jquery,
        links: { mbom: '/mbom' },
        wsMBOM: { wsId: 274 },
        config: { workspaceMBOM: { fieldIDs: {} } },
        customERPFieldIDs: {
            versionId: 'ID_WERSJI',
            partIndex: 'INDEKS_CZESCI',
            syncDate: 'ERP_SYNC_DATE',
            syncStatus: 'ERP_SYNC_STATUS',
            hash: 'ERP_HASH'
        },
        erpSyncBOMViewName: 'ERP Sync',
        erpSyncBOMViewPromise: null,
        erpTechnologyOperationCodeCandidates: ['KOD_OPERACJI'],
        isBlank: context.isBlank,
        normalizeERPBooleanText(value) {
            return value === true || value === 1 || String(value || '').trim().toLowerCase() === 'true';
        },
        getMBOMSaveLink: () => '',
        getCustomMBOMDepth: () => 10
    };
    vm.createContext(syncViewContext);
    ['getERPSyncBOMValue', 'isERPSyncBOMManufacturing', 'getERPSyncBOMProductState',
        'addERPSyncBOMHierarchy', 'validateERPSyncBOMColumns', 'getERPSyncBOMView', 'loadERPSyncBOMParts']
        .forEach(name => vm.runInContext(extractFunction(name), syncViewContext));

    const parts = await syncViewContext.loadERPSyncBOMParts();
    assert.strictEqual(parts.length, 1);
    assert.strictEqual(viewRequests, 1, 'Resolve the ERP Sync view once');
    assert.strictEqual(bomRequests, 1, 'Load all ERP component data with one BOM request');

    let state = syncViewContext.getERPSyncBOMProductState({
        details: { TYPE: 'Manufacturing', INDEKS_CZESCI: 'ERP-100' }
    });
    assert.strictEqual(state.productExists, true,
        'A Manufacturing mBOM with INDEKS_CZESCI already exists as an ERP product');
    assert.strictEqual(state.updateMode, 'index');

    state = syncViewContext.getERPSyncBOMProductState({
        details: { TYPE: 'Manufacturing', INDEKS_CZESCI: '' }
    });
    assert.strictEqual(state.productExists, false,
        'A Manufacturing mBOM without INDEKS_CZESCI still requires add-product');

    state = syncViewContext.getERPSyncBOMProductState({
        details: { TYPE: 'Purchased', INDEKS_CZESCI: 'ERP-200' }
    });
    assert.strictEqual(state.productExists, true,
        'INDEKS_CZESCI is the product-existence marker for every component type');
    assert.strictEqual(state.updateMode, 'product');

    const collectionSource = extractFunction('collectERPTechnologyJobs');
    assert.match(collectionSource, /loadERPSyncBOMParts/);
    assert.doesNotMatch(collectionSource, /getERPTechnologyItemDetails|getERPTechnologyEBOMLink/,
        'ERP collection must not load component details or follow eBOM links');
    console.log('ERP Sync single BOM-view request tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

(async function testRawMaterialsUsesSingleBOMViewRequest() {
    let viewRequests = 0;
    let bomRequests = 0;
    const manufacturingPart = {
        level: 0,
        link: '/mbom/manufacturing',
        details: {
            NUMBER: 'M-100',
            TYPE: 'Manufacturing',
            HAS_BOM: false,
            MATERIAL: 'S355',
            JEDNOSTKA_ROZLICZENIOWA: 'kg',
            ILOSC_ROZLICZENIOWA: 2.5,
            GRUPA_PRODUKTOWA_SUROWCOW: 'RAW'
        }
    };
    const operationPart = {
        level: 1,
        link: '/operation/root',
        details: { TYPE: 'Process' }
    };
    const existingRawMaterialPart = {
        level: 2,
        link: '/raw-material/root',
        details: { TYPE: 'Surowiec' }
    };
    const nestedManufacturingPart = {
        level: 2,
        link: '/mbom/nested',
        details: {
            NUMBER: 'M-200', TYPE: 'Manufacturing', HAS_BOM: false, MATERIAL: 'S235',
            JEDNOSTKA_ROZLICZENIOWA: 'kg', ILOSC_ROZLICZENIOWA: 1,
            GRUPA_PRODUKTOWA_SUROWCOW: 'RAW'
        }
    };
    const nestedOperationPart = {
        level: 3,
        link: '/operation/nested',
        details: { TYPE: 'Process' }
    };
    const nestedRawMaterialPart = {
        level: 4,
        link: '/raw-material/nested',
        details: { TYPE: 'Surowiec' }
    };
    function jquery() {
        return { children() { return { first() { return {}; } }; } };
    }
    jquery.get = async (url, params) => {
        if(url === '/plm/bom-view-by-name') {
            viewRequests++;
            assert.strictEqual(params.name, 'Raw Materials');
            return { data: { id: 88, name: 'Raw Materials' } };
        }
        if(url === '/plm/bom') {
            bomRequests++;
            assert.strictEqual(params.viewId, 88);
            assert.strictEqual(params.depth, 10);
            assert.strictEqual(params.getBOMPartsList, true);
            return { data: { bomPartsList: [
                manufacturingPart,
                operationPart,
                existingRawMaterialPart,
                nestedManufacturingPart,
                nestedOperationPart,
                nestedRawMaterialPart
            ] } };
        }
        throw new Error('Unexpected request: ' + url);
    };
    const rawViewContext = {
        Promise, Object, String, Array, Set, Map, Number, console,
        $: jquery,
        links: { mbom: '/mbom' },
        wsMBOM: { wsId: 274 },
        config: { workspaceMBOM: { fieldIDs: {} } },
        rawMaterialsBOMViewName: 'Raw Materials',
        rawMaterialsBOMViewPromise: null,
        rawMaterialAccountingUnitFieldId: 'JEDNOSTKA_ROZLICZENIOWA',
        rawMaterialAccountingQuantityFieldId: 'ILOSC_ROZLICZENIOWA',
        rawMaterialProductGroupFieldId: 'GRUPA_PRODUKTOWA_SUROWCOW',
        rawMaterialTypeName: 'Surowiec',
        isBlank: context.isBlank,
        normalizeComparisonValue: value => String(value || '').trim().toLowerCase(),
        getMBOMSaveLink: () => '',
        getCustomMBOMDepth: () => 10,
        getMBOMAccountingFieldValue: (part, fieldId) => part.details[fieldId],
        getPartItemLink: part => part.link,
        getPLMItemLevelLink: value => value,
        normalizePLMLink: value => value,
        getMaterialValue: part => part.details.MATERIAL || '',
        getMBOMAccountingUnit: part => part.details.JEDNOSTKA_ROZLICZENIOWA || '',
        getMBOMAccountingQuantity: part => Number(part.details.ILOSC_ROZLICZENIOWA),
        isMBOMHasBOM: value => value === true,
        filterRawMaterialEntriesWithMaterial: entries => entries.filter(entry => entry.material)
    };
    vm.createContext(rawViewContext);
    ['normalizePLMVersionLink', 'hasRawMaterialsBOMColumn', 'validateRawMaterialsBOMColumns', 'getRawMaterialsBOMView',
        'loadRawMaterialsBOMParts', 'isRawMaterialsBOMSourcePart', 'getRawMaterialAssignmentsByMBOM',
        'resolveRawMaterialsBOMViewParts']
        .forEach(name => vm.runInContext(extractFunction(name), rawViewContext));

    const parts = await rawViewContext.loadRawMaterialsBOMParts();
    const materials = rawViewContext.resolveRawMaterialsBOMViewParts(parts);
    assert.strictEqual(viewRequests, 1, 'Resolve the Raw Materials view once');
    assert.strictEqual(bomRequests, 1, 'Load all raw-material source data with one BOM request');
    assert.strictEqual(materials.length, 2);
    assert.strictEqual(materials[0].material, 'S355');
    assert.strictEqual(materials[0].accountingQuantity, 2.5);
    assert.strictEqual(materials[0].productGroup, 'RAW');
    assert.deepStrictEqual(Array.from(materials[0].assignedRawMaterialLinks), ['/raw-material/root'],
        'The parent mBOM knows about its already assigned raw material');
    assert.deepStrictEqual(Array.from(materials[1].assignedRawMaterialLinks), ['/raw-material/nested'],
        'Nested raw materials stay assigned to the nested Manufacturing mBOM');
    assert.strictEqual(materials[0].assignedRawMaterialLinks.has('/raw-material/nested'), false,
        'A nested mBOM raw material must not be mistaken for a parent assignment');

    rawViewContext.rawMaterialApplyModes = {
        addMissing: 'add-missing', updateQuantity: 'update-quantity', overwrite: 'overwrite'
    };
    vm.runInContext(extractFunction('shouldPreserveAssignedRawMaterial'), rawViewContext);
    assert.strictEqual(rawViewContext.shouldPreserveAssignedRawMaterial(
        materials[0], '/raw-material/root', 'add-missing'
    ), true, 'Add-missing must preserve an existing raw-material assignment');
    assert.strictEqual(rawViewContext.shouldPreserveAssignedRawMaterial(
        materials[0], '/raw-material/root', 'overwrite'
    ), false, 'Overwrite mode may update an existing raw-material assignment');

    const startSource = extractFunction('startRawMaterialsFromMBOM');
    assert.match(startSource, /loadRawMaterialsBOMParts/);
    assert.doesNotMatch(startSource, /resolveMBOMMaterials|\/plm\/details|ensureRawMaterialTreeExpanded/,
        'The main Add Raw Materials flow must not load details or expand every mBOM separately');
    console.log('Raw Materials single BOM-view request tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

(async function testERPProductComponentsCoverAllLevels() {
    const makeItem = (link, classes, level) => ({
        length: 1,
        link,
        level,
        hasClass(name) { return classes.includes(name); }
    });
    const root = makeItem('/root', ['root'], 0);
    const operation = makeItem('/operation', ['process'], 1);
    const directComponent = makeItem('/component-a', [], 2);
    const nestedComponent = makeItem('/component-b', [], 8);
    const duplicateNestedComponent = makeItem('/component-b', [], 10);
    const renderedItems = [root, operation, directComponent, nestedComponent, duplicateNestedComponent];
    const productContext = {
        Promise,
        Set,
        console,
        isBlank: context.isBlank,
        normalizePLMLink: value => value || '',
        getERPTechnologyElementLink: item => item.link,
        getElementLevel: item => item.level,
        getMBOMPartFromElement: () => ({}),
        getERPTechnologyItemDetails: async link => ({ link, synced: link === '/component-synced' }),
        getERPTechnologyEBOMLink: () => '',
        isERPProductSynced: details => details.synced === true,
        isAssemblyIndexNode: () => false,
        buildERPAssemblyIndexProductPayload: () => ({ assembly: true }),
        buildERPSubMBOMProductPayload: (item, part, details) => ({ indeks: details.link }),
        getERPTechnologyDescriptor: item => item.link,
        $: value => {
            if(value === '#mbom-tree') {
                return { find() { return { each(callback) { renderedItems.forEach(item => callback.call(item)); } }; } };
            }
            return value;
        }
    };
    vm.createContext(productContext);
    ['getERPProductComponentItems', 'buildERPComponentProductJob'].forEach(name => {
        vm.runInContext(extractFunction(name), productContext);
    });

    const components = productContext.getERPProductComponentItems();
    assert.deepStrictEqual(Array.from(components, item => item.link), ['/component-a', '/component-b'],
        'ERP product discovery must include nested components at every level, exclude roots/operations, and deduplicate items');

    const productJob = await productContext.buildERPComponentProductJob(directComponent);
    assert.strictEqual(productJob.jobType, 'product');
    assert.strictEqual(productJob.productRequired, true);
    assert.strictEqual(productJob.productPayload.indeks, '/component-a');

    const syncedComponent = makeItem('/component-synced', [], 12);
    assert.strictEqual(await productContext.buildERPComponentProductJob(syncedComponent), null,
        'WYSLANE_DO_ERP=true must not enqueue Add Product');
    console.log('All-level ERP component product discovery tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

(async function testERPProductAffectedItems() {
    let changeOrderRequests = 0;
    const affectedContext = {
        Promise,
        isBlank: context.isBlank,
        syncMBOMChangeOrderAfterSave: async () => {
            changeOrderRequests++;
            return { release: '/change-orders/1', add: { added: 4 } };
        }
    };
    vm.createContext(affectedContext);
    vm.runInContext(extractFunction('addERPProductJobsToAffectedItems'), affectedContext);

    const jobs = [
        { link: '/components/1', productSourceLink: '/products/1' },
        { link: '/components/2', productSourceLink: '/products/2' },
        { link: '/components/3', productSourceLink: '/products/1' }
    ];
    const affectedResult = await affectedContext.addERPProductJobsToAffectedItems(jobs, false);
    assert.strictEqual(changeOrderRequests, 1);
    assert.strictEqual(affectedResult.added, 4,
        'ERP synchronization reuses the existing change-order synchronization result');

    await affectedContext.addERPProductJobsToAffectedItems(jobs, true);
    assert.strictEqual(changeOrderRequests, 1, 'Test run must not modify affected items');
    console.log('ERP product affected-item tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

(async function testChangeOrderAffectedItemFiltering() {
    const parts = [
        { link: '/root', details: { TYPE: 'Manufacturing' } },
        { link: '/operation', details: { TYPE: 'Process' } },
        { link: '/sub-mbom', details: { TYPE: 'Manufacturing' } },
        { link: '/raw-material', details: { TYPE: 'Surowiec' } },
        { link: '/purchased', details: { TYPE: 'Purchased' } },
        { link: '/raw-material', details: { TYPE: 'Surowiec' } }
    ];
    const rootItem = { length: 1 };
    const filterContext = {
        Promise,
        Array,
        config: { workspaceMBOM: { fieldIDs: { type: 'TYPE' } } },
        links: { mbom: '/root' },
        rawMaterialTypeName: 'Surowiec',
        rawMaterialsBOMViewName: 'Raw Materials',
        isBlank: context.isBlank,
        normalizeComparisonValue: value => String(value || '').trim().toLowerCase(),
        normalizePLMLink: value => value,
        getPLMItemLevelLink: value => value,
        getPartItemLink: part => part.link,
        getMBOMSaveLink: () => '/root',
        getMBOMAccountingFieldValue: (part, fieldId) => part.details[fieldId],
        getRawMaterialsBOMView: async () => ({ id: 91 }),
        getCustomMBOMDepth: () => 25,
        $(selector) {
            if(selector === '#mbom-tree') return { children: () => ({ first: () => rootItem }) };
            throw new Error('Unexpected selector: ' + selector);
        }
    };
    filterContext.$.get = async (url, params) => {
        assert.strictEqual(url, '/plm/bom');
        assert.strictEqual(params.viewId, 91);
        return { data: { bomPartsList: parts } };
    };
    vm.createContext(filterContext);
    vm.runInContext(extractFunction('loadMBOMChangeOrderAffectedItemLinks'), filterContext);

    const links = await filterContext.loadMBOMChangeOrderAffectedItemLinks();
    assert.deepStrictEqual(Array.from(links), ['/root', '/sub-mbom', '/raw-material'],
        'Only Manufacturing and Surowiec items are included, without duplicates');
    console.log('Change-order affected-item filtering tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

(async function testSaveDoesNotCreateChangeOrder() {
    let affectedCalls = 0;
    let existingLink = '';
    const saveContext = {
        Promise,
        console,
        isBlank: context.isBlank,
        getMBOMChangeOrderWorkspaceId: () => 77,
        getSavedMBOMItems: () => [{ link: '/root', itemNumber: 'M-1' }],
        findExistingMBOMChangeOrder: async () => existingLink,
        loadMBOMChangeOrderAffectedItemLinks: async () => ['/root', '/sub', '/raw'],
        addMissingMBOMAffectedItems: async (release, links) => {
            affectedCalls++;
            assert.strictEqual(release, '/change-orders/1');
            assert.deepStrictEqual(Array.from(links), ['/root', '/sub', '/raw']);
            return { added: 3 };
        }
    };
    vm.createContext(saveContext);
    vm.runInContext(extractFunction('syncMBOMChangeOrderAfterSave'), saveContext);

    let result = await saveContext.syncMBOMChangeOrderAfterSave();
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(affectedCalls, 0, 'Saving without an existing change order performs no mutation');

    existingLink = '/change-orders/1';
    result = await saveContext.syncMBOMChangeOrderAfterSave();
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(affectedCalls, 1, 'Saving with an existing change order adds affected items');
    console.log('Save change-order isolation tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });


(async function testReleasedChangeOrderERPWorkflow() {
    const transitions = [];
    const progress = [];
    const workflowContext = {
        Promise,
        Array,
        waitForMBOMChangeOrderReleased: async () => ({ id: '310', title: 'Released' }),
        sendReleasedMBOMTechnologiesToERP: async () => ({
            jobs: [{ descriptor: 'Child' }, { descriptor: 'Root' }],
            results: [{ descriptor: 'Child', success: true }, { descriptor: 'Root', success: true }]
        }),
        performMBOMChangeOrderTransition: async (link, id, comment) => {
            transitions.push({ link, id, comment });
            return true;
        }
    };
    vm.createContext(workflowContext);
    ['getMBOMERPWorkflowErrorComment', 'continueMBOMReleaseWithERP']
        .forEach(name => vm.runInContext(extractFunction(name), workflowContext));

    const result = await workflowContext.continueMBOMReleaseWithERP('/change-orders/1', (...args) => progress.push(args));
    assert.deepStrictEqual(transitions.map(entry => entry.id), ['569', '567']);
    assert.strictEqual(result.jobs.length, 2);
    assert.ok(progress.some(entry => entry[0] === 'wait' && entry[1] === 'done'));
    assert.ok(progress.some(entry => entry[0] === 'erp' && entry[1] === 'done'));

    transitions.length = 0;
    workflowContext.sendReleasedMBOMTechnologiesToERP = async () => {
        const error = new Error('Impuls unavailable');
        error.erpResults = [{ descriptor: 'Child', success: false, error: 'HTTP 500' }];
        throw error;
    };
    await assert.rejects(
        workflowContext.continueMBOMReleaseWithERP('/change-orders/1'),
        /Impuls unavailable/
    );
    assert.deepStrictEqual(transitions.map(entry => entry.id), ['569', '566']);
    assert.match(transitions[1].comment, /Child: HTTP 500/);
    console.log('Released Change Order ERP workflow tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

(async function testAffectedItemLifecycleTransitionAssignment() {
    const updates = [];
    let catalogRequests = 0;
    const affectedItems = [
        {
            __self__: '/api/v3/workspaces/77/items/1/views/11/affected-items/1',
            item: { link: '/api/v3/workspaces/57/items/101', title: 'Working item', currentState: { title: 'Working' } },
            linkedFields: [{ value: 'keep' }]
        },
        {
            __self__: '/api/v3/workspaces/77/items/1/views/11/affected-items/2',
            item: { link: '/api/v3/workspaces/57/items/102', title: 'Production item', lifecycle: { title: 'Production' } },
            linkedFields: []
        },
        {
            __self__: '/api/v3/workspaces/77/items/1/views/11/affected-items/3',
            item: { link: '/api/v3/workspaces/57/items/103', title: 'Unreleased item', lifecycleState: { title: 'Unreleased' } },
            targetTransition: { title: 'To Production', link: '/api/v3/workspaces/57/transitions/10' },
            linkedFields: []
        }
    ];
    const lifecycleContext = {
        Promise,
        Array,
        isBlank: context.isBlank,
        normalizeComparisonValue: value => String(value || '').trim().toLowerCase(),
        normalizePLMLink: value => String(value || ''),
        getPLMItemLevelLink: value => value,
        getRawMaterialErrorMessage: () => 'Błąd PLM',
        mapPLMRequestsWithConcurrency: async (items, limit, callback) => Promise.all(items.map(callback))
    };
    lifecycleContext.$ = function() {};
    lifecycleContext.$.get = async (url) => {
        if(url === '/plm/manages') return { data: affectedItems };
        if(url === '/plm/workspace-lifecycle-transitions') {
            catalogRequests++;
            return { data: [
                { name: 'To Production', fromState: { title: 'Working' }, __self__: '/api/v3/workspaces/57/transitions/10' },
                { name: 'Production Revision', fromState: { title: 'Production' }, __self__: '/api/v3/workspaces/57/transitions/20' }
            ] };
        }
        throw new Error('Unexpected GET: ' + url);
    };
    lifecycleContext.$.post = async (url, payload) => {
        assert.strictEqual(url, '/plm/update-managed-item');
        updates.push(payload);
        return { data: true };
    };
    vm.createContext(lifecycleContext);
    [
        'getMBOMLifecycleTitle',
        'getMBOMAffectedItemLifecycleState',
        'getMBOMTargetLifecycleTransitionName',
        'loadMBOMAffectedItemLifecycleState',
        'loadMBOMWorkspaceLifecycleTransitions',
        'setMBOMAffectedItemLifecycleTransitions'
    ].forEach(name => vm.runInContext(extractFunction(name), lifecycleContext));

    const result = await lifecycleContext.setMBOMAffectedItemLifecycleTransitions('/change-orders/1');
    assert.strictEqual(catalogRequests, 1, 'Lifecycle transitions are loaded once per affected-item workspace');
    assert.strictEqual(updates.length, 2, 'Items with an already correct target transition are skipped');
    assert.strictEqual(updates[0].transition.endsWith('/10'), true, 'Working uses To Production');
    assert.strictEqual(updates[1].transition.endsWith('/20'), true, 'Production uses Production Revision');
    assert.deepStrictEqual(updates[0].fields, [{ value: 'keep' }], 'Existing linked fields are preserved');
    assert.strictEqual(result.filter(entry => entry.updated).length, 2);
    console.log('Affected-item lifecycle transition tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
(async function testExplicitChangeOrderCreationAndReleaseTransition() {
    const posts = [];
    let existingLink = '';
    const transferCalls = [];
    const lifecycleCalls = [];
    const actionContext = {
        Promise,
        isBlank: context.isBlank,
        getRawMaterialErrorMessage: () => 'Błąd PLM',
        customERPFieldIDs: { relevant: 'ERP_RELEVANT' },
        normalizeComparisonValue: value => String(value || '').trim().toLowerCase(),
        getMBOMChangeOrderWorkspaceId: () => 77,
        getSavedMBOMItems: () => [{ link: '/root', itemNumber: 'M-1' }, { link: '/sub', itemNumber: 'M-2' }],
        findExistingMBOMChangeOrder: async () => existingLink,
        createMBOMChangeOrder: async () => '/change-orders/created',
        addMBOMAffectedItems: async (release, links) => ({ release, added: links.length }),
        moveMBOMsToReleaseInOrder: async (items, release, workspaceId) => {
            transferCalls.push({ items, release, workspaceId });
            return [];
        },
        loadMBOMChangeOrderAffectedItemLinks: async () => ['/root', '/sub', '/raw'],
        addMissingMBOMAffectedItems: async (release, links) => ({ release, added: links.length }),
        setMBOMAffectedItemLifecycleTransitions: async release => { lifecycleCalls.push(release); return []; },
        $(selector) {
            if(selector.indexOf('.pending') >= 0) return { length: 0 };
            throw new Error('Unexpected selector: ' + selector);
        }
    };
    actionContext.$.get = async (url) => {
        if(url === '/plm/sections') return { data: [{ __self__: '/api/v3/workspaces/77/sections/42', title: 'Admin', fields: [{ link: '/api/v3/workspaces/77/sections/42/fields/ERP_RELEVANT' }] }] };
        assert.strictEqual(url, '/plm/transitions');
        return { data: [{ __self__: '/api/v3/workspaces/77/items/1/transitions/1215' }] };
    };
    actionContext.$.post = async (url, payload) => {
        posts.push({ url, payload });
        return { data: true };
    };
    vm.createContext(actionContext);
    ['getMBOMChangeOrderFieldId', 'getMBOMERPRelevantAdminSectionId', 'performMBOMChangeOrderTransition', 'setMBOMChangeOrderERPRelevant', 'createMBOMChangeOrderFromEditor'].forEach(name => {
        vm.runInContext(extractFunction(name), actionContext);
    });

    let result = await actionContext.createMBOMChangeOrderFromEditor(false);
    assert.strictEqual(result.created, true);
    assert.strictEqual(result.transitioned, false);
    assert.deepStrictEqual(transferCalls[0].items, [{ link: '/sub', itemNumber: 'M-2' }]);
    assert.strictEqual(transferCalls[0].release, '/change-orders/created');
    assert.strictEqual(transferCalls[0].workspaceId, 77);
    assert.strictEqual(lifecycleCalls[0], '/change-orders/created');
    assert.strictEqual(posts.length, 0, 'Approval action only creates and prepares the change order');

    existingLink = '/change-orders/existing';
    result = await actionContext.createMBOMChangeOrderFromEditor(true);
    assert.strictEqual(result.created, false, 'An active change order is reused instead of duplicated');
    assert.strictEqual(result.transitioned, true);
    assert.strictEqual(transferCalls[1].release, '/change-orders/existing');
    assert.strictEqual(lifecycleCalls[1], '/change-orders/existing');
    assert.strictEqual(posts[0].url, '/plm/edit', 'ERP relevance is saved before transition 1215');
    assert.strictEqual(posts[0].payload.fields[0].fieldId, 'ERP_RELEVANT');
    assert.strictEqual(posts[0].payload.fields[0].value, true);
    assert.strictEqual(posts[1].url, '/plm/transition');
    assert.strictEqual(posts[1].payload.transition.endsWith('/1215'), true);
    assert.strictEqual(posts[1].payload.comment, 'Zwolnione w mBOM Editor');
    console.log('Explicit change-order action tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

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

(async function testDataManagerERPQuickReleaseWorkflow() {
    const dataPath = path.join(__dirname, '..', 'public', 'javascripts', 'admin', 'data.js');
    const dataSource = fs.readFileSync(dataPath, 'utf8');

    function extractDataFunction(name) {
        const marker = 'function ' + name + '(';
        const start = dataSource.indexOf(marker);
        assert.notStrictEqual(start, -1, 'Missing Data Manager function ' + name);
        const bodyStart = dataSource.indexOf('{', start);
        let depth = 0;
        let quote = '';
        let escaped = false;
        for(let index = bodyStart; index < dataSource.length; index++) {
            const character = dataSource[index];
            if(quote) {
                if(escaped) escaped = false;
                else if(character === '\\') escaped = true;
                else if(character === quote) quote = '';
                continue;
            }
            if(character === '\'' || character === '"' || character === '`') { quote = character; continue; }
            if(character === '{') depth++;
            if(character === '}' && --depth === 0) return dataSource.substring(start, index + 1);
        }
        throw new Error('Could not extract Data Manager function ' + name);
    }

    assert.match(dataSource, /const erpQuickReleaseWorkspaceId = 78;/);

    let rawSyncStatus = 'NOT_SYNCED';
    const statusContext = {
        isBlank: context.isBlank,
        getSectionFieldValue: () => rawSyncStatus,
        erpFieldIDs: { syncStatus: 'ERP_SYNC_STATUS' }
    };
    vm.createContext(statusContext);
    vm.runInContext(extractDataFunction('getERPSyncStatus'), statusContext);
    assert.strictEqual(statusContext.getERPSyncStatus({ sections: [] }), 'NOT_SYNCED');
    rawSyncStatus = 'not_synced';
    assert.strictEqual(statusContext.getERPSyncStatus({ sections: [] }), 'not_synced', 'ERP status must not be normalized');

    const dataHashContext = { isBlank: context.isBlank };
    vm.createContext(dataHashContext);
    vm.runInContext(extractDataFunction('getERPHashResponseValue'), dataHashContext);
    assert.strictEqual(dataHashContext.getERPHashResponseValue({ data: { hash: 'v1:direct' } }), 'v1:direct');
    assert.strictEqual(dataHashContext.getERPHashResponseValue({ data: { data: { hash: 'v1:nested' } } }), 'v1:nested');

    const mbomHashContext = { isBlank: context.isBlank };
    vm.createContext(mbomHashContext);
    vm.runInContext(extractFunction('getERPHashResponseValue'), mbomHashContext);
    assert.strictEqual(mbomHashContext.getERPHashResponseValue({ data: { body: { hash: 'v1:body' } } }), 'v1:body');

    assert.match(extractDataFunction('sendERPQuickReleaseProduct'), /\/plm\/details[\s\S]*useCache\s*:\s*false/,
        'Released item details must be reloaded before building the ERP payload');

    const lifecycleContext = { isBlank: context.isBlank };
    vm.createContext(lifecycleContext);
    vm.runInContext(extractDataFunction('getERPQuickReleaseTargetLifecycle'), lifecycleContext);
    assert.strictEqual(lifecycleContext.getERPQuickReleaseTargetLifecycle('Working'), 'To Production');
    assert.strictEqual(lifecycleContext.getERPQuickReleaseTargetLifecycle('Unreleased'), 'To Production');
    assert.strictEqual(lifecycleContext.getERPQuickReleaseTargetLifecycle('Production'), 'Production Revision');

    const relevantPosts = [];
    const relevantContext = {
        Promise,
        Array,
        addLogEntry: () => {},
        getDataManagerErrorMessage: () => 'PLM error',
        isBlank: context.isBlank,
        erpFieldIDs: { relevant: 'ERP_RELEVANT' },
        $: {
            get: async () => ({ data: [{ __self__: '/api/v3/workspaces/78/sections/84', title: 'Admin', fields: [{ link: '/api/v3/workspaces/78/sections/84/fields/ERP_RELEVANT' }] }] }),
            post: async (url, payload) => { relevantPosts.push({ url, payload }); return { data: true }; }
        }
    };
    vm.createContext(relevantContext);
    ['getERPQuickReleaseFieldId', 'getERPRelevantAdminSectionId', 'setERPQuickReleaseRelevant'].forEach(name => {
        vm.runInContext(extractDataFunction(name), relevantContext);
    });
    await relevantContext.setERPQuickReleaseRelevant('/quick-releases/1');
    assert.strictEqual(relevantPosts[0].url, '/plm/edit');
    assert.strictEqual(relevantPosts[0].payload.fields[0].fieldId, 'ERP_RELEVANT');
    assert.strictEqual(relevantPosts[0].payload.fields[0].sectionId, '84');
    assert.strictEqual(relevantPosts[0].payload.fields[0].value, true);

    async function runScenario(failERP) {
        const events = [];
        const workflowContext = {
            Promise,
            run: {
                erpSyncCandidates: [{ link: '/items/1', descriptor: 'Part 1' }],
                errors: []
            },
            isBlank: context.isBlank,
            addLogEntry: () => {},
            createERPQuickRelease: async () => { events.push('create'); return '/quick-releases/1'; },
            addERPQuickReleaseAffectedItems: async () => { events.push('affected'); },
            setERPQuickReleaseLifecycleTransitions: async () => { events.push('lifecycle'); },
            setERPQuickReleaseRelevant: async () => { events.push('erp-relevant'); },
            performERPQuickReleaseTransition: async (link, transition) => { events.push(String(transition)); },
            waitForERPQuickReleaseState: async (link, state) => { events.push('state:' + state); },
            sendERPQuickReleaseProducts: async () => {
                events.push('send');
                return [{ link: '/items/1', descriptor: 'Part 1', success: !failERP, error: failERP ? 'ERP error' : '' }];
            },
            getERPQuickReleaseErrorComment: () => 'workflow error'
        };
        vm.createContext(workflowContext);
        vm.runInContext(extractDataFunction('finishERPQuickReleaseWorkflow'), workflowContext);

        if(failERP) await assert.rejects(() => workflowContext.finishERPQuickReleaseWorkflow());
        else await workflowContext.finishERPQuickReleaseWorkflow();
        return events;
    }

    assert.deepStrictEqual(
        await runScenario(false),
        ['create', 'affected', 'lifecycle', 'erp-relevant', '509', 'state:286', '1255', 'send', '1252']
    );
    assert.deepStrictEqual(
        await runScenario(true),
        ['create', 'affected', 'lifecycle', 'erp-relevant', '509', 'state:286', '1255', 'send', '1251']
    );
    console.log('Data Manager ERP Quick Release workflow tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
