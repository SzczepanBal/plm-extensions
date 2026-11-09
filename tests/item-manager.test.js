const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dataSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'javascripts', 'admin', 'data.js'), 'utf8');
const viewSource = fs.readFileSync(path.join(__dirname, '..', 'views', 'admin', 'data.pug'), 'utf8');

function extractFunction(name) {
    const marker = 'function ' + name + '(';
    const start = dataSource.indexOf(marker);
    assert.notStrictEqual(start, -1, 'Missing Item Manager function ' + name);
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
    throw new Error('Could not extract Item Manager function ' + name);
}

(function testQuickReleaseSelection() {
    const context = {
        erpQuickReleaseWorkspaceId: 78,
        isBlank: value => value === null || typeof value === 'undefined' || value === '',
        String,
        Error
    };
    vm.createContext(context);
    ['getERPQuickReleaseItemLink', 'getERPQuickReleaseWorkflowState', 'findERPResendQuickRelease'].forEach(name => {
        vm.runInContext(extractFunction(name), context);
    });

    const changes = [{
        item: { link: '/api/v3/workspaces/78/items/456/versions/2' },
        'workflow-state': {
            link: '/api/v3/workspaces/78/workflows/1/states/638',
            title: 'ERP Integration Issue'
        }
    }];
    assert.strictEqual(context.findERPResendQuickRelease(changes), '/api/v3/workspaces/78/items/456');
    assert.throws(() => context.findERPResendQuickRelease([{
        item: { link: '/api/v3/workspaces/78/items/456' },
        'workflow-state': { link: '/api/v3/workspaces/78/workflows/1/states/286', title: 'Released' }
    }]), /638/);
})();

(async function testResendTransitionOrder() {
    async function run(results) {
        const transitions = [];
        const context = {
            Promise,
            Error,
            genItemURL: () => '#',
            addLogEntry: () => {},
            performERPQuickReleaseTransition: async (link, transition) => { transitions.push(String(transition)); },
            sendERPQuickReleaseProducts: async () => results,
            getERPQuickReleaseErrorComment: () => 'ERP resend error',
            addERPQuickReleaseError: () => {}
        };
        vm.createContext(context);
        vm.runInContext(extractFunction('finishERPResendWorkflowGroup'), context);
        return context.finishERPResendWorkflowGroup('/api/v3/workspaces/78/items/456', [{ link: '/item/1', descriptor: 'Item 1' }])
            .then(() => transitions, () => transitions);
    }

    assert.deepStrictEqual(await run([{ success: true }]), ['1250', '1252']);
    assert.deepStrictEqual(await run([{ success: false, error: 'ERP unavailable' }]), ['1250', '1251']);
    assert.match(viewSource, /#resend-to-erp[\s\S]*Prześlij ponownie do ERP/);
    console.log('Item Manager ERP resend workflow tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
