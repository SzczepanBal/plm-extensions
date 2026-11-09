const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourcePath = path.join(__dirname, '..', 'public', 'javascripts', 'custom', 'mbom.js');
const source = fs.readFileSync(sourcePath, 'utf8');
(function testStandardRootMBOMRemainsUnchanged() {
    const standardPath = path.join(__dirname, '..', 'public', 'javascripts', 'apps', 'mbom.js');
    const standardSource = fs.readFileSync(standardPath, 'utf8');
    const paramsMatch = /let paramsMBOM\s*=\s*\{[\s\S]*?\n\s*\}/.exec(standardSource);

    assert.ok(paramsMatch, 'Root MBOM request parameters must exist');
    assert.match(paramsMatch[0], /revisionBias\s*:\s*'release'/,
        'Root MBOM must default to the released version');
    assert.doesNotMatch(standardSource, /getMBOMRootRevisionBias|loadMBOMRootRevisionBias/,
        'ERP-specific revision selection must stay in the custom extension');
    console.log('Standard root MBOM loading remains unchanged');
})();


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

(function testERPProductPropertyLengthLimits() {
    const context = { TextEncoder };
    vm.createContext(context);
    vm.runInContext(extractFunction('truncateERPAssemblyIndexPropertyValue'), context);
    vm.runInContext(extractFunction('truncateERPProductPropertyValue'), context);

    assert.strictEqual(context.truncateERPProductPropertyValue('Nazwa', 'x'.repeat(250)).length, 200,
        'ERP property Nazwa must allow up to 200 characters');
    assert.strictEqual(context.truncateERPProductPropertyValue('Nazwa', 'ż'.repeat(250)).length, 200,
        'The Nazwa limit must count Unicode characters rather than UTF-8 bytes');
    assert.strictEqual(new TextEncoder().encode(context.truncateERPProductPropertyValue('Opis', 'ż'.repeat(50))).length, 40,
        'All ERP properties other than Nazwa must retain the 40-byte limit');

    const dataSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'javascripts', 'admin', 'data.js'), 'utf8');
    assert.match(dataSource, /propertyName\s*===\s*'Nazwa'[\s\S]*?slice\(0, 200\)[\s\S]*?:\s*truncateERPPropertyValue\(value, 40\)/,
        'Data Manager must apply the 200-character exception only to Nazwa');
    console.log('ERP product property length-limit tests passed');
})();

(function testUpdateRevCopiesPropertiesBeforeNormalSave() {
    const revisionSource = extractFunction('updateRevisionFromEBOMToMBOM');
    assert.match(revisionSource, /updateLinkedWorkingMBOMFromReleasedEBOM/,
        'Confirming Update Rev must update the working mBOM immediately');
    assert.doesNotMatch(extractFunction('attachCustomSaveGuard'), /saveMBOMCopiedPropertiesBeforeSave\(\)/,
        'The general Save pipeline must not repeat the Update Rev property synchronization');
    assert.match(extractFunction('attachCustomSaveGuard'), /updateRootWorkingMBOMFromReleasedEBOM\(\)/,
        'Save must update the working root mBOM when its released eBOM revision changed');
    assert.match(extractFunction('attachCustomSaveGuard'), /prepareWorkingSubMBOMsForSave\(\)/,
        'Save must unpin sub-mBOMs and switch their relationship to W before standard save actions are calculated');
    const prepareIndex = extractFunction('attachCustomSaveGuard').indexOf('prepareWorkingSubMBOMsForSave()');
    const actionsIndex = extractFunction('attachCustomSaveGuard').indexOf('setSaveActions()');
    assert.ok(prepareIndex >= 0 && prepareIndex < actionsIndex,
        'Working sub-mBOM links must be prepared before setSaveActions');
    console.log('Update Rev immediate working mBOM synchronization tests passed');
})();

(function testMBOMPropertyRepairButtonIsRestored() {
    const readyBlock = /\$\(document\)\.ready\(function\(\)\s*\{[\s\S]*?\n\s*\}\);/.exec(source);
    assert.ok(readyBlock, 'Custom document-ready block must exist');
    assert.match(readyBlock[0], /insertMBOMPropertyRepairButton\(\)/,
        'Repair mBOM must be inserted when the page becomes ready');
    assert.match(source, /initEditor\s*=\s*function\(\)[\s\S]*?insertMBOMPropertyRepairButton\(\)/,
        'Repair mBOM must also be restored after editor initialization');
    assert.match(extractFunction('runMBOMPropertyRepair'), /repairMBOMPropertiesFromEBOM/,
        'The restored button must execute the existing eBOM-to-mBOM property repair');
    const repairMappings = require('../settings/custom').applications.mbom.mbomRoot.fieldsToCopy;
    assert.ok(repairMappings.some(mapping => mapping.ebom === 'INDEKS_CZESCI' && mapping.mbom === 'INDEKS_CZESCI'),
        'The repair mapping must include INDEKS_CZESCI');
    console.log('Repair mBOM button restoration tests passed');
})();

(function testWorkingSubMBOMRelationshipsAreUnpinnedBeforeSave() {
    const prepareSource = extractFunction('prepareWorkingSubMBOMsForSave');
    const stateSource = extractFunction('setWorkingSubMBOMSaveState');
    const paramsSource = extractFunction('getWorkingSubMBOMSaveParams');

    assert.match(prepareSource, /resolveLinkedMBOMWorkingVersion\(currentLink\)/,
        'Sub-mBOMs without a known W link must resolve their explicit working version');
    assert.match(prepareSource, /\/versions\\\/\\d\+[\s\S]*isMBOMWorkingRevision\(currentRevision\)/,
        'A version-specific row already displaying W must avoid a redundant versions request');
    assert.match(prepareSource, /await \$\.post\('\/plm\/bom-update', params\)/,
        'Existing sub-mBOM relationships must be updated before normal save');
    assert.match(prepareSource, /relationshipAlreadyWorking[\s\S]*!relationshipAlreadyWorking/,
        'An already-unpinned relationship to the same W version must not be written again');
    assert.match(prepareSource, /mapPLMRequestsWithConcurrency\(levelCandidates, concurrency, prepareCandidate\)/,
        'Independent sub-mBOM relationships at the same depth must be prepared concurrently');
    assert.match(paramsSource, /pinned\s*:\s*false/,
        'The pre-save relationship update must remove revision pinning');
    assert.match(stateSource, /\.attr\('data-link-mbom', workingLink\)/,
        'The rendered save target must point to W');
    assert.match(stateSource, /\.attr\('data-mbom', workingLink\)/,
        'The rendered navigation shortcut must point to W');
    assert.match(stateSource, /\.attr\('data-pinned-db', 'false'\)/,
        'The post-update baseline must remain unpinned until release');
    console.log('Working sub-mBOM pre-save unpinning tests passed');
})();

(async function testCustomRootMBOMRevisionFollowsERPSyncStatus() {
    let requestedDetailsLink = '';
    const revisionContext = {
        Array, Promise,
        console: { warn() {} },
        rawMaterialTypeName: 'Surowiec',
        customERPFieldIDs: { syncStatus: 'ERP_SYNC_STATUS' },
        config: {
            workspaceMBOM: { fieldIDs: { type: 'TYPE' } },
            mbomRoot: { typeValue: '/lookups/TYPE/options/MANUFACTURING' }
        },
        isBlank(value) { return value === null || typeof value === 'undefined' || value === ''; },
        normalizeComparisonValue(value) { return String(value || '').trim().toLowerCase(); },
        getPLMItemLevelLink(link) { return String(link || '').replace(/\/versions\/\d+$/i, ''); },
        normalizePLMLink(link) { return String(link || '').replace(/\/versions\/\d+$/i, '').toLowerCase(); },
        normalizePLMVersionLink(link) { return String(link || '').toLowerCase(); },
        getPartItemLink(part) { return part && part.link || ''; },
        getMBOMAccountingFieldValue(part, fieldId) {
            if(part && part.details && Object.prototype.hasOwnProperty.call(part.details, fieldId)) {
                return part.details[fieldId];
            }
            const field = part && Array.isArray(part.fields)
                ? part.fields.find(candidate => candidate.fieldId === fieldId)
                : null;
            return field ? field.value : '';
        },
        getMBOMPropertyRepairSourceLink(details) { return details.storedEBOMLink || ''; },
        resolveLinkedMBOMWorkingVersion: async link => {
            const itemLink = String(link || '').replace(/\/versions\/\d+$/i, '');
            const versionLink = itemLink + '/versions/99';
            return {
                link: versionLink,
                version: { version: 'W', status: 'Working', item: { link: versionLink } }
            };
        },
        $: { get: async (url, params) => {
            if(url === '/plm/versions') {
                if(String(params.link).indexOf('/items/50') >= 0) return { data: { versions: [
                    { version: 'W', status: 'Working', item: { link: '/items/50/versions/9' } },
                    { version: 'B', status: 'Released', item: { link: '/items/50/versions/8' } }
                ] } };
                return { data: { versions: [
                    { version: 'W', status: 'Working', item: { link: '/items/40/versions/1' } }
                ] } };
            }
            requestedDetailsLink = params.link;
            return { data: {
                sections: [{ value: 'UP_TO_DATE' }],
                storedEBOMLink: '/api/v3/workspaces/10/items/20/versions/3'
            } };
        } },
        getSectionFieldValue(sections) { return sections[0] && sections[0].value; },
        getMBOMTechnicalEditText(value) {
            if(value && typeof value === 'object') return value.title || value.label || value.value || '';
            return String(value || '');
        }
    };
    vm.createContext(revisionContext);
    ['getMBOMVersionText', 'isWorkingMBOMVersion', 'getMBOMRootRevisionBias',
        'hasMBOMReleasedEBOMRevisionChanged', 'loadMBOMRootRevisionBias',
        'parseMBOMPinnedValue', 'getMBOMPartTypeForPinning', 'isRawMaterialPartForPinning', 'annotateMBOMPartPinning',
        'isManufacturingPartForRevisionPolicy', 'applyStandardRevisionToMBOMPart', 'findStandardPLMVersion',
        'applyStandardVersionRecordToMBOMPart', 'mergeEditingMBOMRevisionPolicy'].forEach(name => {
        vm.runInContext(extractFunction(name), revisionContext);
    });
    assert.strictEqual(revisionContext.getMBOMRootRevisionBias({ sections: [{ value: 'OUT_OF_DATE' }] }), 'working',
        'An out-of-date ERP status must load the working mBOM');
    assert.strictEqual(revisionContext.getMBOMRootRevisionBias({ sections: [{ value: { title: 'Out of date' } }] }), 'working');
    assert.strictEqual(revisionContext.getMBOMRootRevisionBias({ sections: [{ value: 'UP_TO_DATE' }] }), 'release',
        'An up-to-date ERP status keeps the released mBOM');
    assert.strictEqual(revisionContext.hasMBOMReleasedEBOMRevisionChanged(
        { storedEBOMLink: '/api/v3/workspaces/10/items/20/versions/3' },
        { __self__: '/api/v3/workspaces/10/items/20/versions/4' }
    ), true, 'A newer released eBOM revision must select the working root mBOM');
    assert.strictEqual(await revisionContext.loadMBOMRootRevisionBias(
        '/api/v3/workspaces/57/items/44/versions/6',
        { __self__: '/api/v3/workspaces/10/items/20/versions/4' }
    ), 'working');
    assert.strictEqual(requestedDetailsLink, '/api/v3/workspaces/57/items/44/versions/99',
        'ERP status must be read from the working mBOM version, not the released/item-level record');
    const workingResponse = { data: { edges: [
        { edgeId: 20, isPinned: false },
        { edgeId: 30, isPinned: true },
        { edgeId: 40, isPinned: false },
        { edgeId: 50, isPinned: false },
        { edgeId: 60, isPinned: true },
        { edgeId: 70, isPinned: true }
    ], bomPartsList: [
        { level: 0, link: '/items/10/versions/9', revision: 'W', details: { TYPE: 'Manufacturing' } },
        { level: 1, edgeId: 20, link: '/items/20/versions/5', revision: 'B', details: {}, fields: [
            { fieldId: 'TYPE', value: { link: '/lookups/TYPE/options/MANUFACTURING' } }
        ] },
        { level: 1, edgeId: 30, link: '/items/30/versions/7', revision: 'W', details: { TYPE: 'Surowiec' } },
        { level: 1, edgeId: 40, link: '/items/40/versions/1', revision: 'W', details: { TYPE: 'Purchased' } },
        { level: 1, edgeId: 50, link: '/items/50/versions/9', revision: 'W', details: { TYPE: 'Surowiec' } },
        { level: 1, edgeId: 60, link: '/items/60/versions/3', revision: 'A', details: { TYPE: 'Manufacturing' } },
        { level: 1, edgeId: 70, link: '/items/70/versions/2', revision: 'A', details: { TYPE: 'Purchased' } }
    ] } };
    const standardResponse = { data: { bomPartsList: [
        { link: '/items/10/versions/6', revision: 'A', details: { TYPE: 'Manufacturing' } },
        { link: '/items/20/versions/5', revision: 'B', details: { TYPE: 'Manufacturing' } },
        { link: '/items/30/versions/4', revision: 'C', details: { TYPE: 'Surowiec' } },
        { link: '/items/70/versions/4', revision: 'B', details: { TYPE: 'Purchased' } }
    ] } };
    await revisionContext.mergeEditingMBOMRevisionPolicy(workingResponse, standardResponse);
    assert.strictEqual(workingResponse.data.bomPartsList[0].revision, 'W', 'The editing root remains working');
    assert.strictEqual(workingResponse.data.bomPartsList[1].revision, 'W', 'Editing keeps every sub-mBOM working');
    assert.strictEqual(workingResponse.data.bomPartsList[1].link, '/items/20/versions/99',
        'An unpinned sub-mBOM is explicitly displayed as W');
    assert.strictEqual(workingResponse.data.bomPartsList[2].revision, 'C', 'Non-mBOM items use the latest released revision');
    assert.strictEqual(workingResponse.data.bomPartsList[3].revision, 'W', 'An item without a release remains unreleased');
    assert.strictEqual(workingResponse.data.bomPartsList[4].revision, 'B',
        'A newly added ordinary item absent from the released root still resolves its latest released revision');
    assert.strictEqual(workingResponse.data.bomPartsList[5].revision, 'A',
        'A pinned sub-mBOM stays on its selected revision until Update Rev is clicked');
    assert.strictEqual(workingResponse.data.bomPartsList[6].revision, 'A',
        'A pinned purchased part stays on its selected revision until Update Rev is clicked');
    assert.match(source, /workingArgs\[1\][\s\S]*revisionBias : 'working'/,
        'Editing must load the working mBOM configuration');
    assert.match(source, /standardArgs\[1\][\s\S]*revisionBias : 'release'/,
        'Editing must also load standard revisions for non-mBOM items');
    const inlineSource = extractFunction('fetchInlineSubMBOMChildren');
    assert.match(inlineSource, /isMBOMViewingMode\(\) \? 'release' : 'working'/,
        'Viewing uses standard PLM revisions while editing expands working sub-mBOMs');
    assert.match(inlineSource, /mergeEditingMBOMRevisionPolicy/,
        'Expanded working sub-mBOMs must retain standard revisions for non-mBOM children');
    const revisionMergeSource = extractFunction('mergeEditingMBOMRevisionPolicy');
    assert.match(revisionMergeSource, /workingVersionPromises[\s\S]*resolveLinkedMBOMWorkingVersion/,
        'Repeated inline expansions must reuse working-version resolution requests');
    const inlineAppendSource = extractFunction('appendInlineSubMBOMChildren');
    assert.ok(inlineAppendSource.indexOf("addClass('hidden')") < inlineAppendSource.indexOf("removeClass('hidden')"),
        'Large inline branches must stay outside browser layout until rendering is complete');
    console.log('Custom root MBOM ERP-based revision selection tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

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

(async function testMBOMViewingModeAndWorkingNavigation() {
    const accessContext = {
        Promise,
        isBlank: context.isBlank,
        normalizeComparisonValue: context.normalizeComparisonValue,
        resolveLinkedMBOMWorkingVersion: async () => ({
            link: '/api/v3/workspaces/57/items/9876'
        })
    };
    vm.createContext(accessContext);
    vm.runInContext(extractFunction('isMBOMWorkingRevision'), accessContext);
    vm.runInContext(extractFunction('getMBOMWorkingVersionNavigation'), accessContext);

    assert.strictEqual(accessContext.isMBOMWorkingRevision('W'), true);
    assert.strictEqual(accessContext.isMBOMWorkingRevision('WIP'), true);
    assert.strictEqual(accessContext.isMBOMWorkingRevision('Working'), true);
    assert.strictEqual(accessContext.isMBOMWorkingRevision('A'), false);

    const target = await accessContext.getMBOMWorkingVersionNavigation('/api/v3/workspaces/57/items/1234');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(target)), {
        wsId: '57', dmsId: '9876', link: '/api/v3/workspaces/57/items/9876'
    });

    const accessModeSource = extractFunction('applyMBOMRootAccessMode');
    const disableSource = extractFunction('disableMBOMEditingWidgets');
    const navigationSource = extractFunction('openWorkingMBOMVersion');
    const guardSource = extractFunction('attachMBOMViewingModeGuard');
    const viewingModeSource = extractFunction('isMBOMViewingMode');
    const interactionLockSource = extractFunction('isMBOMInteractionLocked');
    const fullBOMSource = extractFunction('loadFullMBOM');
    const fullBOMVisibilitySource = extractFunction('updateLoadFullMBOMButtonVisibility');
    const fullBOMRequirementSource = extractFunction('refreshFullMBOMLoadRequirement');
    const createRootHookSource = source.match(/createMBOMRoot\s*=\s*function\(ebomItemDetails, callback\) \{[\s\S]*?return originalCreateMBOMRoot\.apply\(this, arguments\);[\s\S]*?\};/)[0];
    assert.match(accessModeSource, /mbom-viewing-mode/);
    assert.match(accessModeSource, /disableMBOMEditingWidgets/);
    assert.match(disableSource, /sortable\('disable'\)/);
    assert.match(disableSource, /droppable\('disable'\)/);
    assert.match(navigationSource, /searchParams\.set\('dmsId'/);

    const cssPath = path.join(__dirname, '..', 'public', 'stylesheets', 'custom', 'mbom.css');
    const cssSource = fs.readFileSync(cssPath, 'utf8');
    assert.match(cssSource, /body\.mbom-viewing-mode #save/);
    assert.match(cssSource, /body\.mbom-viewing-mode #add-all/);
    assert.match(cssSource, /body\.mbom-viewing-mode #add-leaf-mboms-and-materials/);
    assert.match(cssSource, /body\.mbom-viewing-mode #deselect-all/);
    assert.match(cssSource, /body\.mbom-viewing-mode #ebom \.item-actions/);
    assert.match(cssSource, /body\.mbom-loading-mode #main/,
        'Temporary BOM loading mode must block the editor surface');
    assert.match(cssSource, /body\.mbom-full-load-required #save/,
        'An incomplete existing mBOM must use a dedicated temporary edit lock');
    assert.match(guardSource, /'#add-all'/);
    assert.match(guardSource, /'#deselect-all'/);
    assert.doesNotMatch(viewingModeSource, /mbom-loading-mode/,
        'Temporary loading mode must not change revision-selection semantics');
    assert.match(interactionLockSource, /isMBOMViewingMode\(\)[\s\S]*mbom-loading-mode[\s\S]*isFullMBOMLoadRequired\(\)/,
        'The interaction guard must distinguish permanent viewing, active loading, and the full-BOM prerequisite');
    assert.ok(fullBOMSource.indexOf('beginMBOMLoadingMode') < fullBOMSource.indexOf('expandFullMBOMWithBOM'),
        'Full-BOM expansion must enter read-only mode before loading branches');
    assert.match(fullBOMSource, /finally[\s\S]*endMBOMLoadingMode\(\)/,
        'Full-BOM expansion must leave temporary read-only mode after completion or failure');
    assert.match(source, /initEditor\s*=\s*function\(\)[\s\S]*applyMBOMRootAccessMode\(\)[\s\S]*endMBOMLoadingMode\(\)/,
        'Initial loading must remain read-only until the complete BOM has rendered');
    assert.match(source, /endProcessing = function endProcessing\(\)[\s\S]*if\(!isMBOMInteractionLocked\(\)\) \$\('#save'\)\.removeClass\('disabled'\)/,
        'Completing a save in the working mBOM must re-enable Save for subsequent raw-material changes');
    assert.doesNotMatch(fullBOMVisibilitySource, /data-red-item-count/,
        'Red alignment rows must not expose Load full BOM for a newly created or genuinely incomplete mBOM');
    assert.match(fullBOMVisibilitySource, /fullMBOMActionAvailable/,
        'Load full BOM visibility must depend on a verified eligible mBOM branch');
    assert.match(fullBOMRequirementSource, /!mbomExistedBeforeEditorLoad[\s\S]*candidates\.length === 0/,
        'A newly created mBOM or an mBOM without linked subcomponents must not require full loading');
    assert.match(fullBOMRequirementSource, /hasFullMBOMExpansionCandidate/,
        'The full-BOM prerequisite must verify HAS_BOM on linked subcomponents');
    assert.match(createRootHookSource, /mbomExistedBeforeEditorLoad = isExistingMBOMItemLink\(links\.mbom\)/,
        'The editor must remember whether the mBOM existed before automatic root creation');
    console.log('MBOM viewing mode and Working navigation tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

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

    context.apiVersionLinkElement = createLinkElement({
        'data-link-mbom' : '/api/v3/workspaces/57/items/19466/versions/12'
    });
    assert.strictEqual(
        vm.runInContext('getMBOMChildSaveLink(apiVersionLinkElement)', context),
        '/api/v3/workspaces/57/items/19466/versions/12',
        'Saving must retain the selected working/released version link'
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
        isBlank: context.isBlank,
        normalizePLMLink: link => String(link || '').replace(/\/versions\/\d+$/i, '').toLowerCase()
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
    ['normalizeComparisonValue', 'getSearchItemLink', 'getSearchItemFieldValue', 'rawMaterialNumberMatches',
        'getRawMaterialSearchProperty', 'isReleasedRawMaterialItem', 'getRawMaterialVersionOrder',
        'chooseRawMaterialItem', 'createRawMaterialItem', 'ensureRawMaterialSearchResult',
        'getRawMaterialErrorMessage', 'resolveRawMaterialForBatch'].forEach(name => {
        vm.runInContext(extractFunction(name), rawContext);
    });
    const descriptorDiffersFromTitle = {
        title: 'Rura ZS fi 60,3x2mm S235JRH',
        sections: [{ fields: [{
            urn: 'urn.adsk.plm:tenant.workspace.item.field.TITLE',
            value: 'RUR ZS S235JRH ø60,3x2mm'
        }] }]
    };
    assert.strictEqual(
        rawContext.getSearchItemFieldValue(descriptorDiffersFromTitle, 'TITLE'),
        'RUR ZS S235JRH ø60,3x2mm',
        'Raw-material matching must read the explicit TITLE field, not the generated item descriptor'
    );
    assert.strictEqual(
        rawContext.chooseRawMaterialItem('RUR ZS S235JRH ø60,3x2mm', [descriptorDiffersFromTitle]),
        descriptorDiffersFromTitle,
        'A TITLE-query result must not be rejected by comparing its generated descriptor a second time'
    );
    const missing = { material: 'Steel', items: [] };
    const results = await Promise.all([
        rawContext.ensureRawMaterialSearchResult(missing, 'RAW-GROUP'),
        rawContext.ensureRawMaterialSearchResult({ material: ' steel ', items: [] }, 'RAW-GROUP')
    ]);
    assert.strictEqual(posts.length, 1, 'Repeated materials must reuse one creation');
    assert.strictEqual(results[0].items.length, 1, 'A newly created unreleased material is the latest available version');
    assert.strictEqual(results[0].matchingItems[0].__self__, '/api/v3/workspaces/57/items/123');
    assert.strictEqual(results[0].unreleasedOnly, false);
    assert.strictEqual(posts[0].wsId, 57);
    assert.deepStrictEqual(Object.fromEntries(posts[0].fields.map(field => [field.fieldId, field.value])), {
        ...expected, ...Object.fromEntries(dropdowns.map(fieldId => [fieldId, { link: '/options/' + fieldId }]))
    });
    assert.throws(() => rawContext.ensureRawMaterialSearchResult({ ...missing, error: true }), /nie powiodło się/);
    const existing = { material: 'Other', items: [{ title: 'Other' }] };
    assert.strictEqual(await rawContext.ensureRawMaterialSearchResult(existing), existing);
    assert.strictEqual(posts.length, 1);
    const unreleasedMatch = { material: 'Steel', items: [{ title: 'Steel', workingVersion: true }], unreleasedOnly: false };
    assert.strictEqual(await rawContext.ensureRawMaterialSearchResult(unreleasedMatch, 'RAW-GROUP'), unreleasedMatch,
        'An unreleased match is the latest available item and must not create a duplicate raw material');
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
    assert.strictEqual(retriedCreation.items.length, 1, 'A retried creation returns its unreleased working item');
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
    const numberedRawMaterial = { title: 'Steel', NUMBER: 'RM-100', workingVersion: false };
    assert.strictEqual(rawContext.rawMaterialNumberMatches(numberedRawMaterial), true,
        'Until NR_SUROWCA is available on the mBOM, the TITLE query is sufficient');
    assert.strictEqual(rawContext.rawMaterialNumberMatches(numberedRawMaterial, 'RM-100'), true,
        'A future mBOM NR_SUROWCA value must match the raw-material NUMBER');
    assert.strictEqual(rawContext.rawMaterialNumberMatches(numberedRawMaterial, 'RM-200'), false,
        'A different raw-material NUMBER must reject an otherwise matching TITLE');
    const releasedWithoutVersionFieldsA = {
        title: 'Steel', workingVersion: false,
        __self__: '/api/v3/workspaces/57/items/10/versions/1'
    };
    const releasedWithoutVersionFieldsC = {
        title: 'Steel', workingVersion: false,
        __self__: '/api/v3/workspaces/57/items/10/versions/7'
    };
    assert.strictEqual(rawContext.chooseRawMaterialItem('Steel', [releasedWithoutVersionFieldsA, releasedWithoutVersionFieldsC]), releasedWithoutVersionFieldsC,
        'The version number in the item link must select the latest release when search omits version fields');
    assert.strictEqual(rawContext.chooseRawMaterialItem('Steel', [workingItem]), workingItem,
        'A matching item with no released version must use its unreleased working version');
    assert.strictEqual(rawContext.getSearchItemLink({
        __self__: '/api/v3/workspaces/57/items/10/versions/2',
        item: { link: '/api/v3/workspaces/57/items/10' }
    }), '/api/v3/workspaces/57/items/10/versions/2', 'Prefer the revision-specific search result link');
    assert.match(extractFunction('searchRawMaterialItems'), /revision\s*:\s*2/,
        'Raw-material search must request all revisions');
    console.log('Raw material creation tests passed');
}
testRawMaterialCreation().catch(error => { console.error(error); process.exitCode = 1; });

(async function testNewSubMBOMUsesWorkingRevisionImmediately() {
    let viewing = false;
    const requestedLinks = [];
    const insertionContext = {
        Promise,
        config: { workspaceMBOM: { fieldIDs: { type: 'TYPE' } } },
        normalizeComparisonValue: value => String(value || '').trim().toLowerCase(),
        getSectionFieldValue: (sections, fieldId) => sections[fieldId],
        isMBOMViewingMode: () => viewing,
        resolveLinkedMBOMWorkingVersion: async () => ({ link: '/api/v3/workspaces/57/items/20/versions/9' }),
        $: { get: async (url, params) => {
            assert.strictEqual(url, '/plm/details');
            requestedLinks.push(params.link);
            return { data: { sections: { TYPE: 'Manufacturing' }, workingVersion: true, versionId: 9 } };
        } }
    };
    vm.createContext(insertionContext);
    vm.runInContext(extractFunction('resolveAdditionalItemRevision'), insertionContext);

    const releasedDetails = { sections: { TYPE: 'Manufacturing' }, workingVersion: false, versionId: 1 };
    let resolved = await insertionContext.resolveAdditionalItemRevision(
        '/api/v3/workspaces/57/items/20/versions/1',
        releasedDetails
    );
    assert.strictEqual(resolved.link, '/api/v3/workspaces/57/items/20/versions/9');
    assert.strictEqual(resolved.details.workingVersion, true,
        'A sub-mBOM inserted while editing must render W immediately, before reload');

    resolved = await insertionContext.resolveAdditionalItemRevision(
        '/api/v3/workspaces/57/items/30/versions/4',
        { sections: { TYPE: 'Surowiec' }, workingVersion: false, versionId: 4 }
    );
    assert.strictEqual(resolved.link, '/api/v3/workspaces/57/items/30/versions/4',
        'Ordinary items keep their standard selected revision while editing');

    viewing = true;
    resolved = await insertionContext.resolveAdditionalItemRevision(
        '/api/v3/workspaces/57/items/20/versions/1',
        releasedDetails
    );
    assert.strictEqual(resolved.link, '/api/v3/workspaces/57/items/20/versions/1',
        'Viewing mode keeps the standard PLM sub-mBOM revision');
    assert.deepStrictEqual(requestedLinks, ['/api/v3/workspaces/57/items/20/versions/9']);
    console.log('Immediate working sub-MBOM insertion tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

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

(async function testLinkedMBOMQuantityAndRevisionUpdates() {
    let requestedUrl = '';
    let versions = [
        {
            version: '',
            status: { title: 'Working' },
            item: { link: '/api/v3/workspaces/57/items/44/versions/7' }
        },
        {
            version: 'A',
            status: 'Released',
            item: { link: '/api/v3/workspaces/57/items/44/versions/6' }
        }
    ];
    const updateContext = {
        Promise,
        isBlank: context.isBlank,
        normalizeComparisonValue: context.normalizeComparisonValue,
        getPLMItemLevelLink: link => String(link || '').replace(/\/versions\/\d+$/i, ''),
        getRawMaterialErrorMessage: () => 'Błąd PLM',
        $: {
            get: async url => {
                requestedUrl = url;
                return { data: { versions } };
            }
        }
    };
    vm.createContext(updateContext);
    [
        'hasLinkedMBOMRevisionDifference',
        'getMBOMVersionText',
        'isWorkingMBOMVersion',
        'findWorkingMBOMVersion',
        'resolveLinkedMBOMWorkingVersion'
    ].forEach(name => {
        vm.runInContext(extractFunction(name), updateContext);
    });

    const resolved = await updateContext.resolveLinkedMBOMWorkingVersion('/api/v3/workspaces/57/items/44/versions/6');
    assert.strictEqual(requestedUrl, '/plm/versions');
    assert.strictEqual(resolved.link, '/api/v3/workspaces/57/items/44/versions/7');

    let editPayload;
    updateContext.normalizePLMLink = link => String(link || '').replace(/\/versions\/\d+$/i, '').toLowerCase();
    updateContext.loadMBOMPropertyRepairDetails = async link => ({ __self__: link, sections: [{ id: 'source' }] });
    updateContext.getMBOMPropertyRepairMappings = () => [{ ebom: 'TITLE', mbom: 'TITLE' }];
    updateContext.buildMBOMPropertyRepairFields = () => [{ fieldId: 'TITLE', value: 'Revised title' }];
    updateContext.config = { workspaceMBOM: { fieldIDs: { ebom: 'EBOM' } } };
    updateContext.wsMBOM = { sections: [{ id: 'target' }] };
    updateContext.$.post = async (url, payload) => {
        editPayload = { url, payload };
        return { error: false };
    };
    vm.runInContext(extractFunction('updateLinkedWorkingMBOMFromReleasedEBOM'), updateContext);
    const releasedEBOMLink = '/api/v3/workspaces/10/items/20/versions/4';
    await updateContext.updateLinkedWorkingMBOMFromReleasedEBOM({
        length: 1,
        attr(name) { return name === 'data-link' ? releasedEBOMLink : ''; }
    }, resolved.link);
    assert.strictEqual(editPayload.url, '/plm/edit');
    assert.strictEqual(editPayload.payload.link, '/api/v3/workspaces/57/items/44');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(editPayload.payload.fields)), [{
        fieldId: 'TITLE', value: 'Revised title'
    }, {
        fieldId: 'EBOM', value: { link: releasedEBOMLink }
    }], 'Confirming Update Rev must update the working mBOM properties and released eBOM link immediately');

    versions = [{
        version: 'A',
        status: 'Released',
        item: { link: '/api/v3/workspaces/57/items/44/versions/6' }
    }];
    await assert.rejects(
        () => updateContext.resolveLinkedMBOMWorkingVersion('/api/v3/workspaces/57/items/44/versions/6'),
        /nie ma wersji roboczej/i
    );

    assert.strictEqual(updateContext.hasLinkedMBOMRevisionDifference('W', 'A'), true);
    assert.strictEqual(updateContext.hasLinkedMBOMRevisionDifference(' W ', 'w'), false);
    assert.strictEqual(updateContext.hasLinkedMBOMRevisionDifference('B', 'W'), false);
    assert.strictEqual(updateContext.hasLinkedMBOMRevisionDifference('', 'A'), false);

    const quantitySource = extractFunction('updateQuantityFromEBOMToMBOM');
    const revisionSource = extractFunction('updateRevisionFromEBOMToMBOM');
    const revisionStatusSource = extractFunction('refreshLinkedMBOMRevisionStatus');
    const revisionDialogSource = extractFunction('ensureLinkedMBOMRevisionDialog');
    assert.match(quantitySource, /findLinkedMBOMItemForEBOM/);
    assert.match(quantitySource, /originalUpdateQuantityFromEBOMToMBOM/);
    assert.match(revisionSource, /confirmLinkedMBOMRevisionUpdate/);
    assert.match(revisionSource, /resolveLinkedMBOMWorkingVersion/);
    assert.match(revisionSource, /updateLinkedWorkingMBOMFromReleasedEBOM/);
    assert.match(revisionSource, /originalUpdateRevisionFromEBOMToMBOM/);
    assert.match(revisionSource, /data-link-mbom', result\.link/,
        'Updating a sub-mBOM revision must retain its explicit working-version link');
    assert.match(revisionSource, /setMBOMElementPinnedState\(elemMBOMItem, false\)/,
        'Updating a sub-mBOM revision must unpin that relationship while editing');
    assert.match(revisionStatusSource, /different different-revision enable-update/);
    assert.match(revisionDialogSource, /icon-factory/);
    assert.match(revisionDialogSource, /Czy chcesz utworzyć nową technologię bazującą na nowej rewizji/);
    console.log('Linked sub-mBOM quantity and revision update tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
(function testOperationDefroNameMatchesTitle() {
    const operationContext = {
        isBlank: context.isBlank,
        getMBOMWorkspaceFieldSectionId: fieldId => fieldId === 'NAZWA_DEFRO' ? 'technical-section' : ''
    };
    vm.createContext(operationContext);
    vm.runInContext(extractFunction('setMBOMOperationDefroName'), operationContext);

    const fields = [{ fieldId: 'TITLE', value: 'Cięcie', sectionId: 'basic-section' }];
    operationContext.setMBOMOperationDefroName(fields, 'TITLE', 'basic-section');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(fields[1])), {
        fieldId: 'NAZWA_DEFRO', value: 'Cięcie', sectionId: 'technical-section'
    });

    fields[0].value = 'Spawanie';
    operationContext.setMBOMOperationDefroName(fields, 'TITLE', 'basic-section');
    assert.strictEqual(fields.filter(field => field.fieldId === 'NAZWA_DEFRO').length, 1);
    assert.strictEqual(fields[1].value, 'Spawanie');
    console.log('Operation NAZWA_DEFRO creation tests passed');
})();
(function testAssemblyIndexCreationSetsDefroName() {
    const source = extractFunction('createAssemblyIndex');
    assert.match(source, /fieldId\s*:\s*'NAZWA_DEFRO'[\s\S]*?value\s*:\s*assemblyIndexTitle/,
        'A new assembly index must use its generated title as NAZWA_DEFRO');
    console.log('Assembly index NAZWA_DEFRO creation test passed');
})();
(function testMechanicalEBOMTechnicalEditsPreserveERPHash() {
    const synchronizedHash = 'v1:' + 'b'.repeat(64);
    const technicalEditContext = {
        Array,
        Object,
        String,
        isBlank: context.isBlank,
        normalizeComparisonValue: context.normalizeComparisonValue,
        getSectionFieldValue: context.getSectionFieldValue,
        config: { workspaceEBOM: { fieldIDs: { type: 'TYPE' } } },
        customERPFieldIDs: { syncStatus: 'ERP_SYNC_STATUS', hash: 'ERP_HASH' }
    };
    vm.createContext(technicalEditContext);
    ['getMBOMTechnicalEditText', 'getMBOMTechnicalEditPendingHash', 'addMBOMTechnicalEditHash'].forEach(name => {
        vm.runInContext(extractFunction(name), technicalEditContext);
    });

    function details(type, status, hash) {
        return { sections: [{ fields: [
            { id: 'TYPE', value: { title: type } },
            { id: 'ERP_SYNC_STATUS', value: status },
            { id: 'ERP_HASH', value: hash }
        ] }] };
    }

    assert.strictEqual(
        technicalEditContext.getMBOMTechnicalEditPendingHash(details('Mechanical', 'UP_TO_DATE', synchronizedHash)),
        'pending:' + synchronizedHash
    );
    assert.strictEqual(technicalEditContext.getMBOMTechnicalEditPendingHash(details('Mechanical', 'OUT_OF_DATE', synchronizedHash)), '');
    assert.strictEqual(technicalEditContext.getMBOMTechnicalEditPendingHash(details('Manufacturing', 'UP_TO_DATE', synchronizedHash)), '');
    assert.strictEqual(technicalEditContext.getMBOMTechnicalEditPendingHash(details('Mechanical', 'UP_TO_DATE', 'dirty:' + synchronizedHash)), '');

    const fields = [{ fieldId: 'LAST_MBOM_SYNC', value: '2026-10-01' }];
    technicalEditContext.addMBOMTechnicalEditHash(details('Mechanical', 'UP_TO_DATE', synchronizedHash), fields);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(fields[1])), {
        fieldId: 'ERP_HASH', value: 'pending:' + synchronizedHash
    });
    console.log('Mechanical eBOM technical edit ERP hash tests passed');
})();
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
    ['getMBOMPropertyRepairMappings', 'buildMBOMPropertyRepairFields', 'getMBOMCreationDefroName', 'createMBOMForEBOM'].forEach(name => {
        vm.runInContext(extractFunction(name), copyContext);
    });
    const source = {
        __self__: '/items/ebom', root: { link: '/items/root' },
        sections: {
            TITLE: 'Part',
            NAZWA_DEFRO: 'Defro Part',
            INDEKS_CZESCI: 'ERP-4711',
            JEDNOSTKA_ROZLICZENIOWA: '/api/v3/lookups/units/options/kg',
            ILOSC_ROZLICZENIOWA: 2.5,
            GRUPA_PRODUKTOWA_SUROWCOW: 'RAW-GROUP'
        }
    };
    await copyContext.createMBOMForEBOM(source, '');
    assert.strictEqual(payload.fields.find(f => f.fieldId === 'HAS_BOM').value, true);
    assert.strictEqual(payload.fields.find(f => f.fieldId === 'NAZWA_DEFRO').value, 'Defro Part - Technologia',
        'New mBOMs copy NAZWA_DEFRO and add the technology suffix');
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
    delete source.sections.NAZWA_DEFRO;
    await copyContext.createMBOMForEBOM(source, '');
    assert.strictEqual(payload.fields.find(f => f.fieldId === 'NAZWA_DEFRO').value, 'Part - Technologia',
        'New mBOMs use TITLE plus the technology suffix when NAZWA_DEFRO is empty');
    source.sections.NAZWA_DEFRO = 'Existing - Technologia';
    await copyContext.createMBOMForEBOM(source, '');
    assert.strictEqual(payload.fields.find(f => f.fieldId === 'NAZWA_DEFRO').value, 'Existing - Technologia',
        'The technology suffix must not be appended twice');
    delete source.sections.NAZWA_DEFRO;
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
        erpProductFields: { name: ['NAZWA_DEFRO', 'TITLE', 'NUMBER'] },
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

(function testERPAddProductIncludesRequiredFields() {
    const propertyContext = {
        Array,
        Object,
        getBOMBooleanValue(value) {
            return value === true || value === 1 || String(value).toLowerCase() === 'true';
        }
    };
    vm.createContext(propertyContext);
    vm.runInContext(extractFunction('addERPRequiredProductProperties'), propertyContext);

    const properties = propertyContext.addERPRequiredProductProperties([{ Opis: 'Produkt' }], false);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(properties)), [
        { Opis: 'Produkt' },
        { 'Wieloseryjność': '1' }
    ]);

    const existing = propertyContext.addERPRequiredProductProperties([{ 'Wieloseryjność': '0' }], true);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(existing)), [{ 'Wieloseryjność': '2' }],
        'A checked WIELOSERYJNOSC field must be sent once with ERP value 2');

    const finishedGoodGroupContext = {
        isBlank: context.isBlank,
        erpProductDefaults: { finishedGoodGroupSuffix: '_WG' },
        getBOMBooleanValue: value => value === true || value === 1 || String(value || '').toLowerCase() === 'true',
        normalizeComparisonValue: value => String(value || '').trim().toLowerCase()
    };
    vm.createContext(finishedGoodGroupContext);
    vm.runInContext(extractFunction('isERPBuyPart'), finishedGoodGroupContext);
    vm.runInContext(extractFunction('getERPProductGroupId'), finishedGoodGroupContext);
    assert.strictEqual(finishedGoodGroupContext.getERPProductGroupId('KOM', true), 'KOM_WG');
    assert.strictEqual(finishedGoodGroupContext.getERPProductGroupId('KOM', false), 'KOM');
    assert.strictEqual(finishedGoodGroupContext.getERPProductGroupId('KOM', true, 'Buy'), 'KOM',
        'A Buy part must never receive the finished-good suffix');
    assert.strictEqual(finishedGoodGroupContext.getERPProductGroupId('KOM_WG', true), 'KOM_WG',
        'The finished-good suffix must not be duplicated');

    ['buildERPAssemblyIndexProductPayload', 'buildERPSubMBOMProductPayload', 'buildERPSyncBOMProductPayload']
        .forEach(function(name) {
            const source = extractFunction(name);
            assert.match(source, /getERPProductGroupId/,
                name + ' must apply the finished-good product-group mapping');
            assert.match(source, /wlasnosci\s*:\s*addERPRequiredProductProperties\(properties, multiSeries\)/,
                name + ' must map WIELOSERYJNOSC to the Wieloseryjność property');
            assert.match(source, /kontrola_serii\s*:\s*erpProductDefaults\.serialControl/,
                name + ' must obtain commercial-version control from the shared ERP mapping');
            assert.match(source, /numery_seryjne\s*:\s*erpProductDefaults\.serialNumbers/,
                name + ' must obtain serial-number behavior from the shared ERP mapping');
            assert.match(source, /edycja_wh\s*:\s*erpProductDefaults\.commercialVersionEditable/,
                name + ' must obtain commercial-version editing from the shared ERP mapping');
        });

    const checkboxSource = extractFunction('addMBOMMultiSeriesCheckbox');
    const saveSource = extractFunction('saveMBOMMultiSeriesValue');
    assert.match(checkboxSource, /insertBefore[\s\S]*item-revision/,
        'The mBOM checkbox must be rendered before the revision column');
    assert.match(checkboxSource, /node\.isProcess[\s\S]*node\.type[\s\S]*operation[\s\S]*return/,
        'The mBOM checkbox must not be available for operations');
    assert.match(checkboxSource, /isMBOMBuyComponent\(elemNode, node\)[\s\S]*return/,
        'The mBOM checkbox must not be available for Buy components');

    const buyComponentContext = {
        normalizeComparisonValue(value) {
            return String(value || '').trim().toLowerCase();
        }
    };
    vm.createContext(buyComponentContext);
    vm.runInContext(extractFunction('isMBOMBuyComponent'), buyComponentContext);
    assert.strictEqual(buyComponentContext.isMBOMBuyComponent(null, { makeBuy: { title: 'Buy' } }), true);
    assert.strictEqual(buyComponentContext.isMBOMBuyComponent(null, { makeBuy: { title: 'Make' } }), false);
    assert.strictEqual(buyComponentContext.isMBOMBuyComponent(null, {}), false,
        'mBOM items without a Buy classification must keep the checkbox available');
    assert.match(checkboxSource, /saveMBOMMultiSeriesValue/,
        'Changing the mBOM checkbox must persist the item field');
    assert.match(saveSource, /fieldId\s*:\s*erpMultiSeriesFieldId[\s\S]*value\s*:\s*selectedValue/,
        'The checkbox must save WIELOSERYJNOSC as a boolean item field');
    assert.match(saveSource, /selectedValue\s*\?\s*setLinkedEBOMMultiSeriesValue/,
        'Checking WIELOSERYJNOSC must also update the linked eBOM item');
    assert.match(saveSource, /\.always\(function\(\)/,
        'Checkbox cleanup must use jQuery Deferred-compatible always()');
    assert.doesNotMatch(saveSource, /\.finally\(/,
        'Checkbox saving must not require unsupported Promise.finally() on a jQuery Deferred');

    const linkedUpdateSource = extractFunction('setLinkedEBOMMultiSeriesValue');
    assert.match(linkedUpdateSource, /getERPTechnologyEBOMLink/,
        'The linked eBOM update must resolve the eBOM relation from the mBOM item');
    assert.match(linkedUpdateSource, /data-part-number[\s\S]*#ebom \.item[\s\S]*data-link/,
        'The linked eBOM update must fall back to the rendered eBOM row when the relation value is not a usable item link');
    assert.match(linkedUpdateSource, /getMBOMSaveLink\(elemItem\)[\s\S]*\/plm\/details[\s\S]*getERPTechnologyEBOMLink/,
        'The checkbox must reload mBOM details to resolve the authoritative eBOM link');
    assert.match(linkedUpdateSource, /fieldId\s*:\s*erpMultiSeriesFieldId[\s\S]*value\s*:\s*true/,
        'The linked eBOM item must receive WIELOSERYJNOSC=true');

    const linkedJobsSource = extractFunction('buildERPMultiSeriesLinkedProductJobs');
    assert.match(linkedJobsSource, /isERPSyncBOMOperation\(part\)/,
        'ERP linked-product discovery must exclude operations');
    assert.match(linkedJobsSource, /getERPTechnologyItemDetails\(part\.link\)[\s\S]*getSectionFieldValue\([\s\S]*erpMultiSeriesFieldId/,
        'ERP linked-product discovery must read WIELOSERYJNOSC from mBOM item details when the ERP Sync BOM view omits it');
    assert.match(linkedJobsSource, /erpMultiSeriesFieldId[\s\S]*productCallName[\s\S]*buildERPLinkedProductPayload/,
        'Checked mBOM items must create add-product or modify-product jobs for their linked eBOM items');

    const collectionSource = extractFunction('collectERPTechnologyJobs');
    assert.match(collectionSource, /linkedProductJobs\.concat\(orderERPTechnologyJobsBottomUp\(requiredTechnologies\)\)/,
        'Linked eBOM product requests must be queued before add-technology requests');

    const technologyPayloadSource = extractFunction('buildERPTechnologyPayload');
    assert.match(technologyPayloadSource, /opis\s*:\s*getERPTechnologyRevision\(detailsData\)/,
        'Technology opis must contain only the mapped revision');

    const linkedCallSource = extractFunction('getERPLinkedProductCallName');
    assert.match(linkedCallSource, /sentToERP\s*&&\s*!isBlank\(partIndex\)[\s\S]*'modify-product'[\s\S]*'add-product'/,
        'A linked eBOM product already present in ERP must use modify-product; otherwise it must use add-product');

    const linkedPayloadSource = extractFunction('buildERPLinkedProductPayload');
    assert.match(linkedPayloadSource, /addERPRequiredProductProperties\(payload\.wlasnosci, true\)/,
        'The linked eBOM ERP payload must force Wieloseryjność to ERP value 2');
    assert.match(linkedPayloadSource, /callName\s*===\s*'modify-product'[\s\S]*payload\.indeks_czesci/,
        'The linked eBOM modify-product payload must include indeks_czesci');
    assert.doesNotMatch(linkedPayloadSource, /delete payload\.(kontrola_serii|numery_seryjne|edycja_wh)/,
        'The linked eBOM modify-product payload must preserve the commercial-version and serial-number fields');

    const releaseSource = extractFunction('sendReleasedMBOMTechnologiesToERP');
    assert.match(releaseSource, /jobType\s*===\s*'product'[\s\S]*ensureERPProductPrerequisite/,
        'The released mBOM workflow must send linked eBOM product jobs without treating them as technologies');
    console.log('ERP add-product required field tests passed');
})();

(async function testCheckedSubMBOMsCreateLinkedEBOMProductJobs() {
    const detailsByLink = {
        '/mbom/1': { sections: { WIELOSERYJNOSC: true } },
        '/mbom/2': { sections: { WIELOSERYJNOSC: { value: true } } },
        '/mbom/3': { sections: { WIELOSERYJNOSC: false } },
        '/ebom/1': { title: 'EBOM-1', sections: {} },
        '/ebom/2': { title: 'EBOM-2', sections: {} }
    };
    const linkedProductContext = {
        Set,
        Promise,
        Object,
        Number,
        String,
        Error,
        erpMultiSeriesFieldId: 'WIELOSERYJNOSC',
        customERPFieldIDs: { hash: 'ERP_HASH' },
        isERPSyncBOMOperation: () => false,
        isERPSyncBOMManufacturing: part => part.details.TYPE === 'Manufacturing',
        normalizeERPBooleanText(value) {
            if(value && typeof value === 'object') value = value.value;
            return value === true || value === 1 || String(value || '').toLowerCase() === 'true';
        },
        getERPSyncBOMValue(part, ids, fallback) {
            for(const id of ids) {
                if(id && Object.prototype.hasOwnProperty.call(part.details, id)) return part.details[id];
            }
            return fallback;
        },
        mapPLMRequestsWithConcurrency(items, limit, mapper) {
            return Promise.all(items.map(mapper));
        },
        getERPTechnologyItemDetails(link) {
            return Promise.resolve(detailsByLink[link] || null);
        },
        getSectionFieldValue(sections, fieldId, fallback) {
            return sections && Object.prototype.hasOwnProperty.call(sections, fieldId) ? sections[fieldId] : fallback;
        },
        getERPSyncBOMLinkedEBOMLink: part => part.ebom || '',
        getERPTechnologyEBOMLink: () => '',
        normalizePLMLink: value => String(value || ''),
        isBlank: value => value === null || typeof value === 'undefined' || String(value).trim() === '',
        getERPLinkedProductCallName: () => 'add-product',
        buildERPLinkedProductPayload: details => ({ indeks: details.title, wlasnosci: [{ 'Wieloseryjność': '2' }] }),
        $: () => ({})
    };
    vm.createContext(linkedProductContext);
    vm.runInContext(extractFunction('buildERPMultiSeriesLinkedProductJobs'), linkedProductContext);

    const jobs = await linkedProductContext.buildERPMultiSeriesLinkedProductJobs([
        { link: '/mbom/1', ebom: '/ebom/1', title: 'MBOM-1', level: 1, details: { TYPE: 'Manufacturing' } },
        { link: '/mbom/2', ebom: '/ebom/2', title: 'MBOM-2', level: 1, details: { TYPE: 'Manufacturing' } },
        { link: '/mbom/3', ebom: '/ebom/3', title: 'MBOM-3', level: 1, details: { TYPE: 'Manufacturing' } }
    ]);

    assert.deepStrictEqual(JSON.parse(JSON.stringify(jobs.map(job => ({
        callName: job.productCallName,
        link: job.link,
        multiSeries: job.productPayload.wlasnosci[0]['Wieloseryjność']
    })))), [
        { callName: 'add-product', link: '/ebom/1', multiSeries: '2' },
        { callName: 'add-product', link: '/ebom/2', multiSeries: '2' }
    ], 'Two checked sub-mBOM item fields must produce two linked eBOM add-product jobs');
    console.log('Checked sub-mBOM linked eBOM product job tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

(function testERPTechnologyJobsAreAlwaysBottomUp() {
    const orderContext = {
        Map,
        Set,
        Number,
        console: { log() {} },
        isBlank: value => value === null || typeof value === 'undefined' || String(value).trim() === ''
    };
    vm.createContext(orderContext);
    vm.runInContext(extractFunction('normalizeERPTechnologyIndex'), orderContext);
    vm.runInContext(extractFunction('getERPTechnologyJobIndexes'), orderContext);
    vm.runInContext(extractFunction('orderERPTechnologyJobsBottomUp'), orderContext);

    const jobs = [
        {
            link: '/main', level: 0, descriptor: 'Main',
            payload: { indeks: 'MAIN-M', struktura: [{ indeks_skladowy: 'SUB-1' }, { indeks_skladowy: 'SUB-2' }] }
        },
        {
            link: '/sub-1', level: 1, descriptor: 'Sub 1',
            payload: { indeks: 'SUB-1-M', struktura: [] }
        },
        {
            link: '/sub-2', level: 1, descriptor: 'Sub 2',
            payload: { indeks: 'SUB-2-M', struktura: [] }
        }
    ];
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(orderContext.orderERPTechnologyJobsBottomUp(jobs).map(job => job.link))),
        ['/sub-1', '/sub-2', '/main'],
        'Sub-mBOM technologies must be sent before the main mBOM even when ERP indices use the -M variant'
    );

    const aliasedJobs = [
        {
            link: '/alias-main', level: 0, descriptor: 'Main',
            payload: { indeks: 'P00001301-M', struktura: [{ indeks_skladowy: '2430' }] },
            technologyIndexAliases: ['P00001301-M', '2442']
        },
        {
            link: '/alias-child', level: 1, descriptor: 'Child',
            payload: { indeks: 'P00001313-M', struktura: [] },
            technologyIndexAliases: ['P00001313-M', '2430']
        }
    ];
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(orderContext.orderERPTechnologyJobsBottomUp(aliasedJobs).map(job => job.link))),
        ['/alias-child', '/alias-main'],
        'INDEKS_CZESCI aliases must connect parent structure rows to child technology jobs'
    );

    const fallbackJobs = [
        { link: '/fallback-main', level: 0, descriptor: 'Main', payload: { indeks: 'MAIN', struktura: [] } },
        { link: '/fallback-sub', level: 1, descriptor: 'Sub', payload: { indeks: 'SUB', struktura: [] } }
    ];
    assert.deepStrictEqual(
        JSON.parse(JSON.stringify(orderContext.orderERPTechnologyJobsBottomUp(fallbackJobs).map(job => job.link))),
        ['/fallback-sub', '/fallback-main'],
        'Hierarchy depth must keep the main mBOM last when structure-index matching is unavailable'
    );
    console.log('ERP bottom-up technology ordering tests passed');
})();

(function testSubMBOMVersionIdsArePropagatedToParents() {
    const versionContext = {
        Number,
        Object,
        isBlank: value => value === null || typeof value === 'undefined' || String(value).trim() === ''
    };
    vm.createContext(versionContext);
    vm.runInContext(extractFunction('normalizeERPTechnologyIndex'), versionContext);
    vm.runInContext(extractFunction('rememberERPTechnologyVersion'), versionContext);
    vm.runInContext(extractFunction('getERPTechnologyJobIndexes'), versionContext);
    vm.runInContext(extractFunction('rememberERPTechnologyJobVersion'), versionContext);
    vm.runInContext(extractFunction('getERPTechnologyTestVersionPlaceholder'), versionContext);
    vm.runInContext(extractFunction('applyERPChildTechnologyVersions'), versionContext);
    vm.runInContext(extractFunction('validateERPChildTechnologyVersions'), versionContext);
    vm.runInContext(extractFunction('prepareERPNewTechnologyRevision'), versionContext);

    const versionByIndex = {};
    assert.strictEqual(versionContext.rememberERPTechnologyVersion(versionByIndex, 'SUB-1-M', 4711), true);
    const parentJob = {
        payload: {
            struktura: [{ indeks_skladowy: 'SUB-1', id_wersji_skladowej: 10 }]
        }
    };
    assert.strictEqual(versionContext.applyERPChildTechnologyVersions(parentJob, versionByIndex), true);
    assert.strictEqual(parentJob.payload.struktura[0].id_wersji_skladowej, 4711,
        'The parent technology must use the latest ERP id_wersji returned for its sub-mBOM');
    assert.strictEqual(versionContext.applyERPChildTechnologyVersions(parentJob, versionByIndex), false,
        'Applying an unchanged sub-mBOM version must not force another ERP hash calculation');

    const unsyncedChildJob = {
        payload: { indeks: 'P00001313-M', struktura: [] },
        technologyIndexAliases: ['P00001313-M', '2430']
    };
    const placeholder = versionContext.getERPTechnologyTestVersionPlaceholder(unsyncedChildJob);
    assert.strictEqual(placeholder, '{{id_wersji_z_ERP:2430}}');
    assert.strictEqual(versionContext.rememberERPTechnologyJobVersion(versionByIndex, unsyncedChildJob, 9901, false), true);
    assert.strictEqual(versionByIndex['2430'], 9901,
        'A returned child technology version must also be addressable through INDEKS_CZESCI');
    assert.strictEqual(versionContext.rememberERPTechnologyJobVersion(versionByIndex, unsyncedChildJob, placeholder, true), true);
    assert.strictEqual(versionByIndex['2430'], placeholder,
        'Test export must propagate an explicit ERP-result placeholder to its parent request');
    parentJob.requiredChildTechnologyIndexes = ['SUB-1'];
    assert.strictEqual(versionContext.validateERPChildTechnologyVersions(parentJob), true);

    const newRevisionJob = {
        jobType: 'technology',
        payload: {
            id_wersji: 100,
            zablokowana: 'N',
            struktura: [{ indeks_skladowy: 'SUB-1', id_wersji_skladowej: 4711 }]
        }
    };
    versionContext.prepareERPNewTechnologyRevision(newRevisionJob);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(newRevisionJob.payload, 'id_wersji'), false,
        'A newly released revision must not reuse its previous ERP version ID');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(newRevisionJob.payload, 'zablokowana'), false);
    assert.strictEqual(newRevisionJob.payload.struktura[0].id_wersji_skladowej, 4711,
        'Removing the technology own-version ID must preserve child technology references');

    const invalidParentJob = {
        requiredChildTechnologyIndexes: ['SUB-2'],
        payload: { struktura: [{ indeks_skladowy: 'SUB-2' }] }
    };
    assert.throws(
        () => versionContext.validateERPChildTechnologyVersions(invalidParentJob),
        /Brak id_wersji dla sub-mBOM: SUB-2/,
        'A parent technology must not be sent without id_wersji_skladowej for every sub-mBOM'
    );

    const technologyBuilderSource = extractFunction('buildERPSyncBOMTechnologyJob');
    assert.match(technologyBuilderSource, /opis\s*:\s*revision/,
        'Released technology opis must contain only the revision');
    assert.doesNotMatch(technologyBuilderSource, /revisionDescription|Rewizja:/,
        'Released technology opis must not add a revision label or description');
    assert.match(technologyBuilderSource, /payload\.id_wersji\s*=\s*technologyVersionId/,
        'Every existing sub-mBOM technology payload must include its stored id_wersji');
    assert.match(technologyBuilderSource, /technologyVersionId\s*:\s*technologyVersionId/,
        'Technology jobs must retain their stored ERP version for parent propagation');
    assert.match(technologyBuilderSource, /requiredChildTechnologyIndexes[\s\S]*type\s*===\s*'manufacturing'/,
        'Technology jobs must identify every manufacturing sub-mBOM that requires id_wersji_skladowej');
    assert.match(technologyBuilderSource, /if\(!isERPSyncBOMManufacturing\(part\)\) return null/,
        'All Manufacturing mBOMs, including leaves without operations, must create technology jobs');
    assert.doesNotMatch(technologyBuilderSource, /operations\.length\s*===\s*0[^\n]*return null/,
        'A Manufacturing leaf must not be excluded merely because it has no operations');

    const syncSource = extractFunction('syncERPTechnologies');
    assert.match(syncSource, /\.always\(function\(\)/,
        'ERP sync cleanup must use jQuery Deferred-compatible always()');
    assert.doesNotMatch(syncSource, /\.finally\(/,
        'ERP sync must not call unsupported Promise.finally() on a jQuery Deferred');
    assert.match(syncSource, /applyERPChildTechnologyVersions\(job, versionByIndex\)[\s\S]*calculateERPHash\(job\)/,
        'Normal ERP sync must update parent child-version IDs before hashing and sending');
    assert.match(syncSource, /applyERPChildTechnologyVersions\(job, versionByIndex\)[\s\S]*validateERPChildTechnologyVersions\(job\)/,
        'Normal ERP sync must reject incomplete parent structures without sub-mBOM version IDs');
    assert.match(syncSource, /window\.erpClient\.getVersionId\(response\)[\s\S]*rememberERPTechnologyJobVersion/,
        'Normal ERP sync must propagate freshly returned sub-mBOM version IDs');
    assert.match(syncSource, /testRun[\s\S]*getERPTechnologyTestVersionPlaceholder/,
        'Test export must show the child-to-parent version dependency without requiring a live ERP response');

    const previewSource = extractFunction('previewERPTechnologies');
    assert.match(previewSource, /\.always\(function\(\)/,
        'ERP preview cleanup must use jQuery Deferred-compatible always()');
    assert.doesNotMatch(previewSource, /\.finally\(/,
        'ERP preview must not call unsupported Promise.finally() on a jQuery Deferred');
    const releasedSyncSource = extractFunction('sendReleasedMBOMTechnologiesToERP');
    assert.ok(releasedSyncSource.indexOf('prepareERPNewTechnologyRevision(job)') <
        releasedSyncSource.indexOf("'add-technology'"),
    'Released revisions must discard inherited ID_WERSJI before add-technology');
    assert.match(releasedSyncSource, /window\.erpClient\.getVersionId\(response\)[\s\S]*isBlank\(newVersionId\)[\s\S]*updateERPSyncFields\([\s\S]*currentJob\.link/,
        'A released revision must receive a new ERP version ID before writing to its revision-specific PLM link');
    const updateFieldsSource = extractFunction('updateERPSyncFields');
    assert.match(updateFieldsSource, /window\.erpClient\.getVersionIdFromBody\(erpResponseBody\)/,
        'ERP version write-back must use the shared ERP response parser');
    console.log('Sub-mBOM ERP version propagation tests passed');
})();

(function testERPTechnologyResultSummary() {
    const summaryContext = { Array };
    vm.createContext(summaryContext);
    vm.runInContext(extractFunction('getERPTechnologyResultSummary'), summaryContext);

    const summary = summaryContext.getERPTechnologyResultSummary([
        { callName: 'add-product', success: true },
        { callName: 'add-product', success: true },
        { callName: 'modify-product', success: true },
        { callName: 'add-technology', success: true },
        { callName: 'add-technology', success: true },
        { callName: 'rebuild-or-sync', success: false }
    ]);

    assert.deepStrictEqual(JSON.parse(JSON.stringify(summary)), {
        addProduct: 2, modifyProduct: 1, technology: 2, success: 5, failed: 1
    });
    const rendererSource = extractFunction('renderERPTechnologySyncResults');
    assert.match(rendererSource, /PODSUMOWANIE[\s\S]*add-product[\s\S]*modify-product[\s\S]*add-technology/,
        'The mBOM ERP console must show operation counts before detailed records');
    assert.match(rendererSource, /testRun \? 'Wyeksportowane żądania' : 'Wysłane do ERP'/,
        'The summary must distinguish test exports from live sends');
    console.log('ERP technology result summary tests passed');
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
        WYROB_GOTOWY: false,
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
        erpProductFields: { finishedGood: ['WYROB_GOTOWY'], makeOrBuy: ['MAKE_OR_BUY'], index: ['NUMBER'] },
        erpTechnologyOperationCodeCandidates: ['KOD_OPERACJI'],
        isBlank: context.isBlank,
        getBOMBooleanValue(value) {
            return value === true || value === 1 || String(value || '').trim().toLowerCase() === 'true';
        },
        normalizeComparisonValue: value => String(value || '').trim().toLowerCase(),
        normalizeERPBooleanText(value) {
            return value === true || value === 1 || String(value || '').trim().toLowerCase() === 'true';
        },
        getMBOMSaveLink: () => '',
        getCustomMBOMDepth: () => 10
    };
    vm.createContext(syncViewContext);
    ['getERPSyncBOMValue', 'isERPBuyPart', 'validateERPFinishedGoodMakeParts', 'isERPSyncBOMManufacturing', 'getERPSyncBOMProductState',
        'addERPSyncBOMHierarchy', 'validateERPSyncBOMColumns', 'getERPSyncBOMView', 'loadERPSyncBOMParts']
        .forEach(name => vm.runInContext(extractFunction(name), syncViewContext));

    const parts = await syncViewContext.loadERPSyncBOMParts();
    assert.strictEqual(parts.length, 1);
    assert.strictEqual(viewRequests, 1, 'Resolve the ERP Sync view once');
    assert.strictEqual(bomRequests, 1, 'Load all ERP component data with one BOM request');
    assert.throws(function() {
        syncViewContext.validateERPFinishedGoodMakeParts([{
            partNumber: 'BUY-1',
            details: { TYPE: 'Purchased', MAKE_OR_BUY: 'Buy', WYROB_GOTOWY: true }
        }]);
    }, /WYROB_GOTOWY[\s\S]*BUY-1/,
    'A Buy part marked as a finished good must stop the technology release');

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
            assert.strictEqual(params.useCache, false, 'Raw-material discovery must reload the saved structure');
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
    assert.strictEqual(materials[0].hasAssignedRawMaterial, true,
        'A leaf mBOM records that its first operation already contains a raw material');

    const secondOperationOnlyAssignments = rawViewContext.getRawMaterialAssignmentsByMBOM([{
        level: 0, link: '/mbom/second-operation-only', details: { TYPE: 'Manufacturing' }
    }, {
        level: 1, link: '/operation/first-empty', details: { TYPE: 'Process' }
    }, {
        level: 1, link: '/operation/second', details: { TYPE: 'Process' }
    }, {
        level: 2, link: '/raw-material/second-operation', details: { TYPE: 'Surowiec' }
    }]);
    assert.deepStrictEqual(Array.from(secondOperationOnlyAssignments.get('/mbom/second-operation-only')), [],
        'Only a Surowiec below the first operation counts for the quick add-missing check');

    rawViewContext.rawMaterialApplyModes = {
        addMissing: 'add-missing', updateQuantity: 'update-quantity', overwrite: 'overwrite'
    };
    vm.runInContext(extractFunction('shouldPreserveAssignedRawMaterial'), rawViewContext);
    assert.strictEqual(rawViewContext.shouldPreserveAssignedRawMaterial(
        materials[0], '/raw-material/root', 'add-missing'
    ), true, 'Add-missing must preserve an existing raw-material assignment');
    assert.strictEqual(rawViewContext.shouldPreserveAssignedRawMaterial(
        materials[0], '/raw-material/newer-revision', 'add-missing'
    ), true, 'Add-missing must not add a second row when any Surowiec is already below the first operation');
    assert.strictEqual(rawViewContext.shouldPreserveAssignedRawMaterial(
        materials[0], '/raw-material/root', 'overwrite'
    ), false, 'Overwrite mode may update an existing raw-material assignment');

    const differentMaterialSource = extractFunction('getDifferentAssignedRawMaterials');
    const quantityReplacementSource = extractFunction('confirmQuantityOnlyRawMaterialReplacement');
    const overwriteRemovalSource = extractFunction('removeDifferentRawMaterialsForOverwrite');
    const rawMaterialApplySource = extractFunction('addRawMaterialsToMBOM');
    assert.match(differentMaterialSource, /itemLink === desiredItemLink/,
        'Vault overwrite must preserve the raw material selected by the current MATERIAL value');
    assert.match(differentMaterialSource, /isAssignedRawMaterial[\s\S]*isRawMaterialPartForPinning[\s\S]*rawMaterialTypeName/,
        'Vault overwrite removal must be restricted to raw-material relationships');
    assert.match(overwriteRemovalSource, /elemExisting\.remove\(\)[\s\S]*existingState\.children\.delete/,
        'A different old raw material must be removed from both the editor and duplicate-check state');
    assert.ok((rawMaterialApplySource.match(/removeDifferentRawMaterialsForOverwrite/g) || []).length >= 2,
        'Overwrite must remove stale raw materials whether the desired material already exists or must be inserted');
    assert.ok(rawMaterialApplySource.indexOf('getRawMaterialItemDetails(link)') <
        rawMaterialApplySource.lastIndexOf('removeDifferentRawMaterialsForOverwrite'),
    'When inserting a replacement, the new raw material must be validated before the old one is removed');
    assert.match(quantityReplacementSource, /window\.confirm[\s\S]*usuń stary surowiec i dodaj nowy/,
        'Quantity-only mode must explain that the user can replace a different assigned raw material');
    assert.match(rawMaterialApplySource, /mode === rawMaterialApplyModes\.updateQuantity[\s\S]*differentRawMaterials\.length > 0[\s\S]*confirmQuantityOnlyRawMaterialReplacement/,
        'Quantity-only mode must warn whenever a different raw material is assigned');
    assert.match(rawMaterialApplySource, /!quantityModeReplacementApproved[\s\S]*Aktualizacja ilości została pominięta/,
        'Declining replacement must preserve the old material and skip quantity changes');
    assert.match(rawMaterialApplySource, /mode === rawMaterialApplyModes\.overwrite \|\| quantityModeReplacementApproved/,
        'Accepting the warning must use the same safe remove-and-replace path as Vault overwrite');

    const startSource = extractFunction('startRawMaterialsFromMBOM');
    assert.match(startSource, /loadRawMaterialsBOMParts/);
    assert.match(startSource, /ensureRawMaterialTreeExpanded/,
        'The main Add Raw Materials flow must reload the live editor structure before discovery');
    assert.match(startSource, /getRawMaterialDOMSourceParts[\s\S]*pendingParts/,
        'Unsaved sub-mBOMs from the live editor must be included in discovery');
    assert.match(startSource, /includeLoadedParts\s*:\s*false[\s\S]*includeDOMParts\s*:\s*false/,
        'Only newly inserted sub-mBOMs should require direct detail resolution');
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
        { level: 0, link: '/root', details: { TYPE: 'Manufacturing' } },
        { level: 1, link: '/operation', details: { TYPE: 'Process' } },
        { level: 1, link: '/sub-mbom', details: { TYPE: 'Manufacturing' }, isPinned: false },
        { level: 1, link: '/pinned-sub-mbom', details: { TYPE: 'Manufacturing' }, isPinned: true },
        { level: 1, link: '/raw-material', details: { TYPE: 'Surowiec' }, isPinned: false },
        { level: 1, link: '/purchased', details: { TYPE: 'Purchased' }, isPinned: true }
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
        normalizePLMVersionLink: value => value,
        getPLMItemLevelLink: value => value,
        getPartItemLink: part => part.link,
        annotateMBOMPartPinning: response => response,
        isManufacturingPartForRevisionPolicy: part => part.details.TYPE === 'Manufacturing',
        isERPSyncBOMOperation: part => part.details.TYPE === 'Process',
        parseMBOMPinnedValue: value => typeof value === 'boolean' ? value : null,
        mapPLMRequestsWithConcurrency: async (items, concurrency, mapper) => Promise.all(items.map(mapper)),
        resolveLinkedMBOMWorkingVersion: async link => ({ link }),
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
    assert.deepStrictEqual(Array.from(links), ['/root', '/operation', '/sub-mbom'],
        'Manufacturing and Process items are included; purchased parts and raw materials stay outside the change order');
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
        pinMBOMManufacturingRelationshipsForRelease: async () => [],
        loadERPSyncBOMParts: async () => [],
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
    const releaseSource = extractFunction('createMBOMChangeOrderFromEditor');
    assert.ok(releaseSource.indexOf("loadERPSyncBOMParts('working')") <
        releaseSource.indexOf('findExistingMBOMChangeOrder'),
    'Finished-good validation must run before a change order is created or reused');
    assert.ok(releaseSource.indexOf('pinMBOMManufacturingRelationshipsForRelease') <
        releaseSource.indexOf('performMBOMChangeOrderTransition'),
    'Manufacturing relationships must be pinned before the release transition');
    const pinningSource = extractFunction('pinMBOMManufacturingRelationshipsForRelease');
    assert.match(pinningSource, /pinned\s*:\s*true/);
    assert.match(pinningSource, /isProcess[\s\S]*type\s*!==\s*'manufacturing'[\s\S]*!isProcess/,
        'Process relationships must be revision-pinned together with Manufacturing relationships');
    assert.match(extractFunction('getMBOMElementPinnedState'), /rawMaterialTypeName[\s\S]*return false/,
        'Raw-material relationships must always save as unpinned');
    const createSource = extractFunction('createMBOMChangeOrder');
    assert.match(createSource, /CHANGE_TEMPLATE[\s\S]*Fast Track[\s\S]*templateField/,
        'Change-order creation must select the Fast Track change template');
    assert.match(createSource, /'TITLE'[\s\S]*'DESCRIPTION'/,
        'Change-order creation must continue to populate Title and Description');
    assert.match(source, /addBOMItems\s*=\s*function\(\)[\s\S]*?pinned\s*:\s*getMBOMElementPinnedState/,
        'New BOM edges use the explicit per-row pinning policy');
    assert.match(source, /updateBOMItems\s*=\s*function\(\)[\s\S]*?pinned\s*:\s*getMBOMElementPinnedState/,
        'Ordinary BOM updates preserve the explicit per-row pinning policy');
    console.log('Explicit change-order action tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

(async function testStateDrivenChangeOrderWorkflowControls() {
    const requests = [];
    const workflowContext = {
        Promise,
        mbomChangeOrderStateByLink: {},
        isBlank: context.isBlank,
        normalizePLMLink: link => String(link || '').toLowerCase(),
        getMBOMChangeOrderWorkspaceId: () => 84,
        getSavedMBOMItems: () => [{ link: '/api/v3/workspaces/57/items/1' }],
        findExistingMBOMChangeOrder: async () => '/api/v3/workspaces/84/items/9',
        getMBOMChangeOrderState: data => ({ id: data.stateId, title: data.stateTitle }),
        $: { get: async (url, params) => {
            requests.push({ url, params });
            if(url === '/plm/details') return { data: { stateId: '200', stateTitle: 'Kontrola technologii' } };
            if(url === '/plm/transitions') return { data: [
                { name: 'Zatwierdź', __self__: '/api/v3/workspaces/84/items/9/transitions/1215' },
                { name: 'Odrzuć', __self__: '/api/v3/workspaces/84/items/9/transitions/1159' }
            ] };
            throw new Error('Unexpected request ' + url);
        } }
    };
    vm.createContext(workflowContext);
    ['getMBOMChangeOrderTransitionName', 'loadMBOMChangeOrderWorkflow'].forEach(name => {
        vm.runInContext(extractFunction(name), workflowContext);
    });

    const workflow = await workflowContext.loadMBOMChangeOrderWorkflow();
    assert.strictEqual(workflow.link, '/api/v3/workspaces/84/items/9');
    assert.strictEqual(workflow.state.title, 'Kontrola technologii');
    assert.deepStrictEqual(Array.from(workflow.actions, action => action.name), ['Zatwierdź', 'Odrzuć']);
    assert.deepStrictEqual(requests.map(request => request.url), ['/plm/details', '/plm/transitions'],
        'The CO status and currently permitted workflow transitions must both be loaded');
    assert.strictEqual(workflowContext.getMBOMChangeOrderTransitionName(workflow.actions[0]), 'Zatwierdź');

    let openedWorkflowURL = '';
    workflowContext.genItemURL = params => {
        assert.strictEqual(params.link, '/api/v3/workspaces/84/items/9');
        assert.strictEqual(params.tab, 'workflow');
        return '/fusion-change-order-workflow';
    };
    workflowContext.window = { open: (url, target) => {
        openedWorkflowURL = url;
        assert.strictEqual(target, '_blank');
    } };
    vm.runInContext(extractFunction('openMBOMChangeOrderWorkflow'), workflowContext);
    assert.strictEqual(workflowContext.openMBOMChangeOrderWorkflow(workflow.link), true);
    assert.strictEqual(openedWorkflowURL, '/fusion-change-order-workflow');

    const insertSource = extractFunction('insertMBOMChangeOrderButtons');
    const selectionSource = extractFunction('performSelectedMBOMChangeOrderTransition');
    const refreshSource = extractFunction('refreshMBOMChangeOrderControls');
    assert.match(insertSource, /<select><\/select>/, 'An active CO uses one workflow selector');
    assert.doesNotMatch(insertSource, /release-mbom-technology/, 'The fixed release button must not be inserted');
    assert.match(selectionSource, /transitionLink === '__open_workflow__'/,
        'The workflow selector must handle navigation without performing a transition');
    assert.ok(refreshSource.indexOf('__open_workflow__') < refreshSource.indexOf('workflow.actions.forEach'),
        'Go to workflow must be listed before the available transitions');
    assert.match(selectionSource, /transitionId === '1215'/,
        'The release transition keeps the existing ERP release automation');
    const changeOrderActionSource = extractFunction('runMBOMChangeOrderAction');
    assert.match(changeOrderActionSource, /elemAction\.hasClass\('disabled'\)/,
        'Create CO must check its own enabled state rather than the hidden disabled workflow selector');
    assert.doesNotMatch(changeOrderActionSource, /\.finally\(/,
        'Create CO cleanup must be compatible with jQuery Deferred promises');
    assert.doesNotMatch(selectionSource, /\.finally\(/,
        'Workflow-transition cleanup must be compatible with jQuery Deferred promises');
    const viewingGuardSource = extractFunction('attachMBOMViewingModeGuard');
    assert.doesNotMatch(viewingGuardSource, /start-mbom-approval|mbom-change-order-workflow/,
        'CO and workflow actions must remain usable while a released mBOM is displayed');
    const customMBOMCSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'stylesheets', 'custom', 'mbom.css'), 'utf8');
    assert.doesNotMatch(customMBOMCSS, /body\.mbom-viewing-mode #start-mbom-approval/,
        'Viewing-mode CSS must not hide the Create CO action');
    console.log('State-driven change-order workflow control tests passed');
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
    const attrs = {};
    const row = {
        hasClass: () => false,
        toggleClass(name, value) { missing = value; },
        children() { return this; },
        attr(name, value) {
            if(arguments.length > 1) { attrs[name] = value; return this; }
            return attrs[name];
        },
        removeAttr(name) { delete attrs[name]; return this; },
        remove() { addActionRemoved = true; }
    };
    const presentRow = {
        length: 1,
        hasClass(name) { return name === 'match'; }
    };
    Object.assign(ctx, {
        isBlank: context.isBlank,
        $(value) { return value === '#ebom' ? { find: () => ({ each: cb => cb.call(row) }) } : value; },
        getLinkedMBOMLinkFromEBOMElement: () => '/api/v3/workspaces/57/items/123',
        findLinkedMBOMItemForEBOM: () => present ? presentRow : ({ length: 0 }),
        addLinkedMBOMInsertAction() {},
        setLinkedEBOMBOMCheckPending(item, value) { pending = value; },
        setHolisticItemState(item, value) { state = value; },
        getStandardMBOMStatus(item) {
            if(!item || item.length === 0) return '';
            return item.hasClass('match') ? 'match' : '';
        }
    });
    vm.runInContext(extractFunction('refreshMissingLinkedMBOMStatus'), ctx);
    ctx.refreshMissingLinkedMBOMStatus();
    assert.strictEqual(missing, true);
    assert.strictEqual(attrs['data-linked-mbom-missing-state'], 'true');
    assert.strictEqual(state, 'additional', 'Linked MBOM absent from parent must be red');
    assert.strictEqual(pending, false, 'Missing item must not remain gray awaiting expansion');
    present = true;
    state = 'match';
    ctx.refreshMissingLinkedMBOMStatus();
    assert.strictEqual(missing, false);
    assert.strictEqual(attrs['data-linked-mbom-missing-state'], undefined,
        'Clear the stale missing marker as soon as the linked mBOM is rendered');
    assert.strictEqual(addActionRemoved, true, 'Remove stale Add MBOM action after nested MBOM is found');
    assert.strictEqual(state, 'match', 'Do not override comparison status when linked MBOM is present');
    const customSource = fs.readFileSync(sourcePath, 'utf8');
    assert.match(customSource, /insertFromEBOMToMBOM = function\(elemAction\)[\s\S]*resolveLinkedMBOMWorkingVersion\(linkedMBOM\)/,
        'Adding an existing linked sub-mBOM in editing mode must resolve W before cloning the eBOM row');
    assert.match(customSource, /children\('\.item-head'\)\.children\('\.item-revision'\)\.first\(\)\.text\('W'\)/,
        'The newly cloned sub-mBOM row must display W immediately');
    assert.match(customSource, /attr\('data-new-linked-mbom', 'true'\)[\s\S]*callback\(links\.mbom\)/,
        'A newly created mBOM must be identified before the conversion callback inserts it');
    assert.match(customSource, /isNewlyCreatedMBOM[\s\S]*insertLinkedMBOMWithoutEBOMChildren/,
        'A newly created working mBOM must be inserted without waiting for PLM version indexing');
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
    const customLoaderPath = path.join(__dirname, '..', 'public', 'javascripts', 'custom.js');
    const customLoaderSource = fs.readFileSync(customLoaderPath, 'utf8');
    const customDataPath = path.join(__dirname, '..', 'public', 'javascripts', 'custom', 'erp-interface-admin.js');
    const customDataSource = fs.readFileSync(customDataPath, 'utf8');
    const plmRoutePath = path.join(__dirname, '..', 'routes', 'plm.js');
    const plmRouteSource = fs.readFileSync(plmRoutePath, 'utf8');
    const erpRoutePath = path.join(__dirname, '..', 'routes', 'erp.js');
    const erpRouteSource = fs.readFileSync(erpRoutePath, 'utf8');
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const erpMapping = require('../settings/erp-mapping');
    const environment = require('../environment');

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
    assert.match(customLoaderSource, /enableERPInterfaceAdmin\s*=\s*false[\s\S]*if\(!enableERPInterfaceAdmin\) return/,
        'The unfinished ERP Interface Admin override must remain disabled');
    assert.match(customDataSource, /version\s*:\s*2/,
        'The browser mapping must migrate the updated Data Manager payload contract');
    assert.match(customDataSource, /descriptionFields\s*:\s*\['OPIS'\][\s\S]*descriptionMaxLength\s*:\s*25/,
        'The active Data Manager override must append at most 25 OPIS characters');
    assert.match(customDataSource, /\['UWAGI', 'Uwagi'\]/,
        'The active Data Manager override must include the UWAGI mapping');
    assert.match(customDataSource, /WIELOSERYJNOSC[\s\S]*multiSeries \? '2' : '1'/,
        'The Data Manager override must map WIELOSERYJNOSC false/true to ERP 1/2');
    assert.match(customDataSource, /kontrola_serii\s*:\s*'T'[\s\S]*numery_seryjne\s*:\s*'WPD'[\s\S]*edycja_wh\s*:\s*'T'/,
        'The Data Manager override must include the new fields for both add-product and modify-product');
    assert.match(plmRouteSource, /router\.use\(require\('\.\/erp'\)/,
        'The PLM router must mount the dedicated ERP router');
    assert.doesNotMatch(plmRouteSource, /router\.(get|post)\('\/custom-erp/,
        'ERP endpoints must not be defined directly in the PLM router');
    assert.match(erpRouteSource, /'modify-product'\s*:\s*\{[\s\S]*?kontrola_serii\s*:\s*'T'[\s\S]*?numery_seryjne\s*:\s*'WPD'[\s\S]*?edycja_wh\s*:\s*'T'/,
        'The modify-product proxy example must document the new supported fields');
    assert.match(erpRouteSource, /function applyRequiredProductControls[\s\S]*kontrola_serii[\s\S]*numery_seryjne[\s\S]*edycja_wh/,
        'The ERP proxy must enforce the required product controls for every item request');
    assert.strictEqual(environment.erp.simulationMode, true,
        'The local test environment must prevent outbound ERP calls');
    assert.match(appSource, /simulationMode\s*:\s*!!\(environment\.erp[\s\S]*\|\|[\s\S]*ERP_SIMULATION_MODE/,
        'A locally active ERP simulation must not be disabled by an environment-variable override');
    assert.match(erpRouteSource, /if\(erpSettings\.simulationMode\)[\s\S]*invokeCustomErpSimulation[\s\S]*return/,
        'ERP simulation mode must return before the outbound API call');
    assert.match(erpRouteSource, /getCustomErpSimulationBody[\s\S]*indeks_czesci[\s\S]*id_wersji/,
        'ERP simulation must return product and technology identifiers so PLM updates execute');
    assert.match(source, /const erpSimulationMode\s*=\s*common\.erp\.simulationMode\s*===\s*true/,
        'The mBOM client must recognize the server-side ERP simulation environment');
    assert.match(extractFunction('isERPTechnologyTestRunEnabled'), /!erpSimulationMode/,
        'Server-side simulation must run the PLM-writing path rather than export-only test run');
    assert.match(erpRouteSource, /router\.get\('\/custom-erp\/mapping'/,
        'The ERP router must expose the active shared mapping for administration');
    assert.strictEqual(erpMapping.operations.modifyProduct.extends, 'addProduct',
        'modify-product must inherit the common product mapping');
    assert.strictEqual(erpMapping.operations.addTechnology.endpoint, 'add-technology',
        'add-technology must have its own operation mapping');
    assert.ok(Array.isArray(erpMapping.operations.addProduct.propertyProfiles.assemblyIndex),
        'The common product mapping must include the assembly-index profile');

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

    const productCallContext = {
        Object,
        isBlank: context.isBlank,
        erpFieldIDs: { sentToERP: 'WYSLANE_DO_ERP', partIndex: 'INDEKS_CZESCI' },
        getSectionFieldValue: (sections, fieldId) => sections[fieldId],
        getERPFieldValue: (sections, fieldId) => sections[fieldId]
    };
    vm.createContext(productCallContext);
    ['isERPSyncRequired', 'normalizeERPBooleanValue', 'getERPSentToERP', 'getERPProductCallName'].forEach(name => {
        vm.runInContext(extractDataFunction(name), productCallContext);
    });
    assert.strictEqual(productCallContext.isERPSyncRequired('NOT_SYNCED'), true);
    assert.strictEqual(productCallContext.isERPSyncRequired('OUT_OF_DATE'), true);
    assert.strictEqual(productCallContext.isERPSyncRequired('UP_TO_DATE'), false);
    assert.strictEqual(productCallContext.getERPProductCallName({ sections: { WYSLANE_DO_ERP: true, INDEKS_CZESCI: 'ERP-1' } }), 'modify-product');
    assert.strictEqual(productCallContext.getERPProductCallName({ sections: { WYSLANE_DO_ERP: false, INDEKS_CZESCI: 'ERP-1' } }), 'add-product');
    assert.strictEqual(productCallContext.getERPProductCallName({ sections: { WYSLANE_DO_ERP: true, INDEKS_CZESCI: '' } }), 'add-product');
    assert.strictEqual(productCallContext.getERPProductCallName({ sections: { WYSLANE_DO_ERP: { value: true }, INDEKS_CZESCI: 'ERP-2' } }), 'modify-product');

    const sharedERPPath = path.join(__dirname, '..', 'public', 'javascripts', 'framework', 'erp.js');
    delete require.cache[require.resolve(sharedERPPath)];
    require(sharedERPPath);
    assert.strictEqual(global.erpClient.getHash({ data: { hash: 'v1:direct' } }), 'v1:direct');
    assert.strictEqual(global.erpClient.getHash({ data: { data: { hash: 'v1:nested' } } }), 'v1:nested');
    assert.strictEqual(global.erpClient.getHash({ data: { body: { hash: 'v1:body' } } }), 'v1:body');
    assert.strictEqual(global.erpClient.getPartIndex({ data: { body: { indeks: 'P-100' } } }), 'P-100');
    assert.strictEqual(global.erpClient.getVersionId({ data: { body: { ID_WERSJI: '4711' } } }), 4711);
    assert.deepStrictEqual(global.erpClient.getProductSuccessFields({
        response : { data : { body : { indeks : 'P-100' } } },
        hash     : 'v1:test',
        callName : 'add-product'
    }, {
        hash      : 'ERP_HASH',
        partIndex : 'INDEKS_CZESCI',
        sentToERP : 'WYSLANE_DO_ERP'
    }), [
        { fieldId : 'ERP_HASH', value : 'pending:v1:test' },
        { fieldId : 'INDEKS_CZESCI', value : 'P-100' },
        { fieldId : 'WYSLANE_DO_ERP', value : true }
    ], 'A simulated ERP success must produce the same PLM fields as a live add-product success');
    assert.match(dataSource, /window\.erpClient\.execute\([\s\S]*exportOnly\s*:\s*options\.testRun/,
        'Data Manager and Item Manager must use the shared ERP client for simulation and live calls');
    const completionSource = extractDataFunction('genCompletionRequests');
    assert.match(completionSource, /getProductSuccessFields[\s\S]*addFieldToPayload/,
        'Data Manager test mode must persist shared ERP success fields in PLM');
    assert.doesNotMatch(completionSource, /sync-to-erp[^\n]*&&\s*!options\.testRun/,
        'ERP test mode must not suppress PLM success-field updates');
    assert.match(source, /window\.erpClient\.request\([\s\S]*exportOnly\s*:\s*testRun/,
        'mBOM must use the same shared ERP client');
    assert.doesNotMatch(dataSource, /\/plm\/custom-erp\/(?:export-request\/)?['" +]/,
        'Data Manager must not construct ERP proxy URLs itself');
    assert.doesNotMatch(source, /erpTechnologyProxyBaseUrl/,
        'mBOM must not maintain a separate ERP proxy base URL');

    assert.match(extractDataFunction('sendERPQuickReleaseProduct'), /\/plm\/details[\s\S]*useCache\s*:\s*false/,
        'Released item details must be reloaded before building the ERP payload');

    const dataProductPayloadContext = {
        erpPropertyMappings: [[['UWAGI'], 'Uwagi', false]],
        erpFieldIDs: { partIndex: 'INDEKS_CZESCI' },
        erpProductFields: erpMapping.operations.addProduct.fields,
        erpProductDefaults: erpMapping.operations.addProduct.defaults,
        erpModifyProductMapping: {
            fields: erpMapping.operations.addProduct.fields
        },
        isBlank: context.isBlank,
        getERPFieldValue: (sections, fieldId) => sections[fieldId] || '',
        getSectionFieldValue: (sections, fieldId, fallback) => Object.prototype.hasOwnProperty.call(sections, fieldId) ? sections[fieldId] : fallback,
        normalizeERPBooleanValue: value => value === true || value === 1 || String(value).toLowerCase() === 'true',
        getERPUnitOfMeasure: () => 'szt',
        addERPProperty(properties, sections, fieldId, propertyName) {
            if(!sections[fieldId]) return;
            const property = {};
            property[propertyName] = sections[fieldId];
            properties.push(property);
        },
        addERPPropertyValue(properties, propertyName, value, includeWhenBlank) {
            if(context.isBlank(value) && includeWhenBlank !== true) return;
            const property = {};
            property[propertyName] = value;
            properties.push(property);
        }
    };
    vm.createContext(dataProductPayloadContext);
    vm.runInContext(extractDataFunction('getERPProductGroupId'), dataProductPayloadContext);
    vm.runInContext(extractDataFunction('isERPFinishedGoodBuy'), dataProductPayloadContext);
    vm.runInContext(extractDataFunction('buildERPSyncPayload'), dataProductPayloadContext);
    const addProductPayload = dataProductPayloadContext.buildERPSyncPayload({ sections: {
        NUMBER: 'P-1', NAZWA_DEFRO: 'Produkt', OPIS: 'Opis produktu dłuższy niż dwadzieścia pięć znaków',
        GRUPA_PRODUKTOWA: 'GRP', UWAGI: 'Uwaga z PLM'
    } }, 'add-product');
    assert.strictEqual(addProductPayload.nazwa_czesci, 'Produkt - Opis produktu dłuższy niż',
        'Data Manager combines the Defro name with at most 25 description characters for nazwa_czesci');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(addProductPayload.wlasnosci)), [
        { Uwagi: 'Uwaga z PLM' },
        { 'Wieloseryjność': '1' }
    ], 'Data Manager add-product maps UWAGI and includes Wieloseryjność');
    assert.strictEqual(addProductPayload.kontrola_serii, 'T');
    assert.strictEqual(addProductPayload.numery_seryjne, 'WPD');
    assert.strictEqual(addProductPayload.edycja_wh, 'T');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(addProductPayload, 'wersja_handlowa_edytowalna'), false);
    const multiSeriesPayload = dataProductPayloadContext.buildERPSyncPayload({ sections: {
        NUMBER: 'P-2', NAZWA_DEFRO: 'Produkt wieloseryjny', GRUPA_PRODUKTOWA: 'GRP', WIELOSERYJNOSC: true
    } }, 'add-product');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(multiSeriesPayload.wlasnosci)), [
        { 'Wieloseryjność': '2' }
    ], 'Data Manager maps a checked WIELOSERYJNOSC field to ERP value 2');
    const finishedGoodPayload = dataProductPayloadContext.buildERPSyncPayload({ sections: {
        NUMBER: 'P-WG', NAZWA_DEFRO: 'Wyrób gotowy', GRUPA_PRODUKTOWA: 'KOM', WYROB_GOTOWY: true
    } }, 'add-product');
    assert.strictEqual(finishedGoodPayload.id_grupy, 'KOM_WG',
        'Data Manager appends _WG to the product group for a finished good');
    const invalidBuyFinishedGood = {
        NUMBER: 'B-WG', NAZWA_DEFRO: 'Kupowany wyrób', GRUPA_PRODUKTOWA: 'KOM',
        MAKE_OR_BUY: 'Buy', WYROB_GOTOWY: true
    };
    assert.strictEqual(dataProductPayloadContext.isERPFinishedGoodBuy({ sections: invalidBuyFinishedGood }), true);
    assert.strictEqual(dataProductPayloadContext.buildERPSyncPayload({ sections: invalidBuyFinishedGood }, 'add-product').id_grupy, 'KOM',
        'A Buy part never receives the _WG suffix');
    assert.strictEqual(addProductPayload.id_grupy, 'GRP',
        'Data Manager leaves the product group unchanged for a non-finished good');
    const modifyProductPayload = dataProductPayloadContext.buildERPSyncPayload({ sections: {
        NUMBER: 'P-1', NAZWA_DEFRO: 'Produkt', OPIS: 'Opis produktu dłuższy niż dwadzieścia pięć znaków',
        GRUPA_PRODUKTOWA: 'GRP', UWAGI: 'Uwaga z PLM'
    } }, 'modify-product');
    assert.strictEqual(modifyProductPayload.nazwa_czesci, 'Produkt - Opis produktu dłuższy niż');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(modifyProductPayload.wlasnosci)), [
        { Uwagi: 'Uwaga z PLM' },
        { 'Wieloseryjność': '1' }
    ], 'Data Manager modify-product maps UWAGI and WIELOSERYJNOSC=false to ERP value 1');
    assert.strictEqual(modifyProductPayload.kontrola_serii, 'T');
    assert.strictEqual(modifyProductPayload.numery_seryjne, 'WPD');
    assert.strictEqual(modifyProductPayload.edycja_wh, 'T');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(modifyProductPayload, 'wersja_handlowa_edytowalna'), false);

    const buySections = {
        NUMBER: 'B-1', NAZWA_DEFRO: 'Kupowany produkt', OPIS: 'Opis nie może trafić do nazwy',
        MAKE_OR_BUY: 'Buy', GRUPA_PRODUKTOWA: 'GRP'
    };
    const buyAddPayload = dataProductPayloadContext.buildERPSyncPayload({ sections: buySections }, 'add-product');
    const buyModifyPayload = dataProductPayloadContext.buildERPSyncPayload({
        sections: Object.assign({ INDEKS_CZESCI: 'ERP-B-1' }, buySections)
    }, 'modify-product');
    assert.strictEqual(buyAddPayload.nazwa_czesci, 'Kupowany produkt',
        'Buy add-product uses only NAZWA_DEFRO for nazwa_czesci');
    assert.strictEqual(buyModifyPayload.nazwa_czesci, 'Kupowany produkt',
        'Buy modify-product uses only NAZWA_DEFRO for nazwa_czesci');

    assert.strictEqual(erpMapping.operations.addProduct.propertyProfiles.default.some(mapping =>
        mapping.erp === 'Uwagi' && mapping.plm.includes('UWAGI')), true,
    'The shared mapping maps the PLM UWAGI field to ERP Uwagi');
    assert.deepStrictEqual(erpMapping.operations.addProduct.fields.finishedGood, ['WYROB_GOTOWY'],
        'The shared mapping identifies the finished-good PLM field');
    assert.strictEqual(erpMapping.operations.addProduct.defaults.finishedGoodGroupSuffix, '_WG');
    assert.match(customDataSource, /WYROB_GOTOWY[\s\S]*productGroup\.endsWith\('_WG'\)/,
        'The configurable Data Manager mapping also applies the finished-good group suffix');
    assert.match(dataSource, /common\.erp\.mapping/,
        'Data Manager consumes the shared ERP mapping');
    assert.match(source, /common\.erp\.mapping/,
        'mBOM consumes the shared ERP mapping');

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
    const errorContext = { isBlank: context.isBlank, JSON, String, Array };
    vm.createContext(errorContext);
    vm.runInContext(extractDataFunction('getDataManagerErrorMessage'), errorContext);
    assert.strictEqual(
        errorContext.getDataManagerErrorMessage({ responseJSON: { error: true, data: { message: 'Element jest zablokowany.' } } }),
        'Element jest zablokowany.'
    );
    assert.strictEqual(
        errorContext.getDataManagerErrorMessage({ status: 500, statusText: 'Internal Server Error', responseText: '<html>Error</html>' }),
        'HTTP 500 Internal Server Error'
    );
    console.log('Data Manager ERP Quick Release workflow tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

(function testPLMEditFieldSectionResolution() {
    const routePath = path.join(__dirname, '..', 'routes', 'plm.js');
    const routeSource = fs.readFileSync(routePath, 'utf8');

    function extractRouteFunction(name) {
        const match = new RegExp('function\\s+' + name + '\\s*\\(').exec(routeSource);
        if(!match) throw new Error('Could not find route function ' + name);
        const bodyStart = routeSource.indexOf('{', match.index);
        let depth = 0;
        for(let index = bodyStart; index < routeSource.length; index++) {
            if(routeSource[index] === '{') depth++;
            if(routeSource[index] === '}' && --depth === 0) return routeSource.slice(match.index, index + 1);
        }
        throw new Error('Could not extract route function ' + name);
    }

    const routeContext = { isBlank: context.isBlank, String, Array };
    vm.createContext(routeContext);
    vm.runInContext(extractRouteFunction('getFieldSection'), routeContext);

    const selfSection = {
        __self__: '/api/v3/workspaces/57/items/1/views/1/sections/84',
        fields: [{ __self__: '/api/v3/workspaces/57/items/1/views/1/fields/ERP_HASH' }]
    };
    assert.strictEqual(
        routeContext.getFieldSection([selfSection], { fieldId: 'ERP_HASH' }),
        selfSection,
        'PLM edit must resolve fields represented by __self__ instead of link'
    );

    const idSection = { id: 85, fields: [{ id: 'ERP_SYNC_STATUS' }] };
    assert.strictEqual(routeContext.getFieldSection([idSection], { fieldId: 'ERP_SYNC_STATUS' }), idSection);
    console.log('PLM edit field-section resolution tests passed');
})();
