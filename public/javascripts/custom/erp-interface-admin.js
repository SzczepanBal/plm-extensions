(function() {
    'use strict';

    if(window.location.pathname.toLowerCase() !== '/data') return;

    const DEFAULT_MAPPING = {
        version : 1,
        fields  : {
            index : { label : 'Part number', erpField : 'indeks', plmFields : ['NUMBER'] },
            name : { label : 'Part name', erpField : 'nazwa_czesci', plmFields : ['NAZWA_DEFRO'], fallbackFields : ['TITLE', 'NUMBER'], separator : ' - ' },
            group : { label : 'Product group', erpField : 'id_grupy', plmFields : ['GRUPA_PRODUKTOWA'] },
            unit : { label : 'Unit of measure', erpField : 'jednostka_miary', plmFields : ['UNIT_OF_MEASURE', 'UOM', 'UNIT', 'BOM_UOM', 'ITEM_UOM'], defaultValue : 'szt' },
            partIndex : { label : 'ERP part index', erpField : 'indeks_czesci', plmFields : ['INDEKS_CZESCI'] }
        },
        properties : [
            ['MATERIAL', 'Materiał'], ['ITEM_WEIGHT', 'Masa'], ['OPIS', 'Opis'], ['NAZWA', 'Nazwa'],
            ['TITLE', 'Tytuł'], ['TITLE', 'Tutuł'], ['GRUPA_PRODUKTOWA', 'Grupa produktowa'],
            ['NAZWA_URZDZENIA', 'Nazwa urządzenia'], ['TYP_CZESCI', 'Typ części'], ['RODZAJ', 'Rodzaj'],
            ['WARIANT', 'Wariant'], ['SPECYFIKACJA', 'Specyfikacja'], ['PRODUCENT', 'Producent'],
            ['SZEROKOSC', 'Szerokość'], ['DUGOSC', 'Długość'], ['WYSOKOSC', 'Wysokość/grubość'],
            ['SREDNICA', 'Średnica'], ['KOLOR', 'Kolor'], ['POWLOKA', 'Powłoka'], ['MOC', 'Moc'],
            ['MOC_WIELKOSC', 'Moc/Wielkość'], ['NAPICIE', 'Napięcie'], ['PRD', 'Prąd'],
            ['WYDAJNO', 'Wydajność'], ['TEMPERATURA', 'Temperatura'], ['GSTO', 'Gęstość']
        ].map(function(entry) { return { plmField : entry[0], erpProperty : entry[1], enabled : true }; })
    };

    let mapping = loadMapping();

    function initialize() {
        if(typeof window.buildERPSyncPayload !== 'function') return;
        installPayloadBuilder();
        insertAdminButton();
    }

    if(document.readyState === 'complete') window.setTimeout(initialize, 0);
    else window.addEventListener('load', initialize);

    function storageKey() {
        let tenantName = (typeof window.tenant === 'string' && window.tenant) ? window.tenant : window.location.host;
        return 'plm-extensions.erp-interface.' + tenantName;
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function sanitize(config) {
        if(!config || typeof config !== 'object' || !config.fields || !Array.isArray(config.properties)) {
            throw new Error('The mapping file does not have the expected structure.');
        }

        let result = clone(DEFAULT_MAPPING);
        Object.keys(result.fields).forEach(function(key) {
            let source = config.fields[key];
            if(!source || typeof source !== 'object') return;
            let fields = cleanList(source.plmFields);
            if(fields.length) result.fields[key].plmFields = fields;
            if(Object.prototype.hasOwnProperty.call(result.fields[key], 'fallbackFields')) result.fields[key].fallbackFields = cleanList(source.fallbackFields);
            if(Object.prototype.hasOwnProperty.call(result.fields[key], 'separator') && typeof source.separator === 'string') result.fields[key].separator = source.separator.substring(0, 10);
            if(Object.prototype.hasOwnProperty.call(result.fields[key], 'defaultValue') && typeof source.defaultValue === 'string') result.fields[key].defaultValue = source.defaultValue.trim().substring(0, 128);
        });

        if(config.properties.length > 250) throw new Error('A maximum of 250 property mappings is supported.');
        result.properties = config.properties.map(function(entry) {
            let plmField = text(entry && entry.plmField, 128);
            let erpProperty = text(entry && entry.erpProperty, 128);
            if(!plmField || !erpProperty) throw new Error('Every property row requires both a PLM field ID and an ERP property.');
            return { plmField : plmField, erpProperty : erpProperty, enabled : !entry || entry.enabled !== false };
        });
        result.updatedAt = new Date().toISOString();
        return result;
    }

    function text(value, limit) {
        return (typeof value === 'string') ? value.trim().substring(0, limit) : '';
    }

    function cleanList(value) {
        if(!Array.isArray(value)) return [];
        return value.map(function(entry) { return text(entry, 128); }).filter(function(entry, index, values) {
            return entry && values.indexOf(entry) === index;
        }).slice(0, 50);
    }

    function loadMapping() {
        try {
            let saved = window.localStorage.getItem(storageKey());
            return saved ? sanitize(JSON.parse(saved)) : clone(DEFAULT_MAPPING);
        } catch(error) {
            console.warn('Could not load custom ERP mapping:', error.message);
            return clone(DEFAULT_MAPPING);
        }
    }

    function saveMapping(config) {
        mapping = sanitize(config);
        window.localStorage.setItem(storageKey(), JSON.stringify(mapping));
        installPayloadBuilder();
    }

    function getFirstValue(sections, fieldIds, defaultValue) {
        for(let fieldId of (fieldIds || [])) {
            let value = window.getERPFieldValue(sections, fieldId);
            if(!window.isBlank(value)) return value;
        }
        return defaultValue || '';
    }

    function installPayloadBuilder() {
        window.buildERPSyncPayload = function(details, erpCallName) {
            let sections = (details && details.sections) ? details.sections : [];
            let nameConfig = mapping.fields.name;
            let partNumber = getFirstValue(sections, mapping.fields.index.plmFields, '');
            let partName = nameConfig.plmFields.map(function(fieldId) {
                return window.getERPFieldValue(sections, fieldId);
            }).filter(function(value) { return !window.isBlank(value); }).join(nameConfig.separator);
            if(window.isBlank(partName)) partName = getFirstValue(sections, nameConfig.fallbackFields, partNumber);

            let properties = [];
            mapping.properties.forEach(function(entry) {
                if(entry.enabled !== false) window.addERPProperty(properties, sections, entry.plmField, entry.erpProperty);
            });

            let rawUnit = getFirstValue(sections, mapping.fields.unit.plmFields, mapping.fields.unit.defaultValue);
            let payload = {
                indeks          : partNumber,
                nazwa_czesci    : partName,
                id_grupy        : getFirstValue(sections, mapping.fields.group.plmFields, ''),
                jednostka_miary : window.normalizeERPUnitOfMeasureValue(rawUnit),
                wlasnosci       : properties
            };

            if(erpCallName === 'modify-product') {
                payload.indeks_czesci = getFirstValue(sections, mapping.fields.partIndex.plmFields, partNumber);
            }
            return payload;
        };
    }

    function insertAdminButton() {
        if(document.getElementById('custom-erp-interface-admin')) return;
        let button = $('<button type="button" id="custom-erp-interface-admin" class="button with-icon icon-settings">ERP Mapping</button>');
        button.on('click', openEditor);
        let toolbar = $('#header-toolbar');
        if(toolbar.length) toolbar.prepend(button);
    }

    function openEditor() {
        if($('#custom-erp-admin-overlay').length) return;
        let overlay = $('<div id="custom-erp-admin-overlay"></div>').appendTo('body');
        let panel = $('<div class="custom-erp-admin-panel surface-level-1"></div>').appendTo(overlay);
        let header = $('<div class="custom-erp-admin-header dark"></div>').appendTo(panel);
        $('<div><h1>ERP Interface Admin</h1><p>Product mapping used by Data Manager → Sync to ERP</p></div>').appendTo(header);
        let actions = $('<div class="custom-erp-admin-actions"></div>').appendTo(header);
        $('<button type="button" class="button">Import</button>').on('click', importMapping).appendTo(actions);
        $('<button type="button" class="button">Export</button>').on('click', exportMapping).appendTo(actions);
        $('<button type="button" class="button">Reset</button>').on('click', resetMapping).appendTo(actions);
        $('<button type="button" class="button main">Save</button>').on('click', saveEditor).appendTo(actions);
        $('<button type="button" class="button icon icon-close"></button>').on('click', closeEditor).appendTo(actions);

        let content = $('<div class="custom-erp-admin-content"></div>').appendTo(panel);
        $('<div id="custom-erp-admin-message" role="status" aria-live="polite"></div>').appendTo(content);
        renderCoreFields(content);
        renderProperties(content);
        $('<p class="custom-erp-admin-note">Saved per tenant in this browser. Use Export/Import to promote the mapping to another browser or administrator.</p>').appendTo(content);
    }

    function renderCoreFields(content) {
        let card = $('<section class="custom-erp-card"><h2>Core fields</h2><p>Enter PLM field IDs in priority order, separated by commas.</p></section>').appendTo(content);
        let rows = $('<div class="custom-erp-core"></div>').appendTo(card);
        Object.keys(mapping.fields).forEach(function(key) {
            let field = mapping.fields[key];
            let row = $('<div class="custom-erp-core-row"></div>').attr('data-key', key).appendTo(rows);
            $('<div class="custom-erp-core-label"><strong></strong><span></span></div>').appendTo(row)
                .find('strong').text(field.label).end().find('span').text('ERP: ' + field.erpField);
            $('<label>PLM field IDs<input class="custom-erp-plm-fields" type="text"></label>').appendTo(row).find('input').val(field.plmFields.join(', '));
            let options = $('<div class="custom-erp-options"></div>').appendTo(row);
            if(field.fallbackFields) $('<label>Fallback IDs<input class="custom-erp-fallback-fields" type="text"></label>').appendTo(options).find('input').val(field.fallbackFields.join(', '));
            if(Object.prototype.hasOwnProperty.call(field, 'separator')) $('<label>Separator<input class="custom-erp-separator" type="text"></label>').appendTo(options).find('input').val(field.separator);
            if(Object.prototype.hasOwnProperty.call(field, 'defaultValue')) $('<label>Default<input class="custom-erp-default" type="text"></label>').appendTo(options).find('input').val(field.defaultValue);
        });
    }

    function renderProperties(content) {
        let card = $('<section class="custom-erp-card"></section>').appendTo(content);
        let heading = $('<div class="custom-erp-card-heading"><div><h2>ERP properties</h2><p>Disabled or empty properties are not sent.</p></div></div>').appendTo(card);
        $('<button type="button" class="button with-icon icon-add">Add mapping</button>').on('click', function() { appendPropertyRow({ enabled : true }); }).appendTo(heading);
        let table = $('<table class="custom-erp-table"><thead><tr><th>Enabled</th><th>PLM field ID</th><th>ERP property</th><th></th></tr></thead><tbody id="custom-erp-properties"></tbody></table>').appendTo(card);
        mapping.properties.forEach(appendPropertyRow);
        return table;
    }

    function appendPropertyRow(entry) {
        let row = $('<tr></tr>').appendTo('#custom-erp-properties');
        $('<td><input class="custom-erp-enabled" type="checkbox"></td>').appendTo(row).find('input').prop('checked', entry.enabled !== false);
        $('<td><input class="custom-erp-property-plm" type="text" placeholder="PLM_FIELD_ID"></td>').appendTo(row).find('input').val(entry.plmField || '');
        $('<td><input class="custom-erp-property-erp" type="text" placeholder="ERP property"></td>').appendTo(row).find('input').val(entry.erpProperty || '');
        $('<td><button type="button" class="button icon icon-delete" title="Delete"></button></td>').appendTo(row).find('button').on('click', function() { row.remove(); });
    }

    function collectEditor() {
        let result = clone(mapping);
        $('.custom-erp-core-row').each(function() {
            let field = result.fields[$(this).attr('data-key')];
            field.plmFields = splitList($(this).find('.custom-erp-plm-fields').val());
            if($(this).find('.custom-erp-fallback-fields').length) field.fallbackFields = splitList($(this).find('.custom-erp-fallback-fields').val());
            if($(this).find('.custom-erp-separator').length) field.separator = $(this).find('.custom-erp-separator').val();
            if($(this).find('.custom-erp-default').length) field.defaultValue = $(this).find('.custom-erp-default').val();
        });
        result.properties = [];
        $('#custom-erp-properties tr').each(function() {
            result.properties.push({
                enabled : $(this).find('.custom-erp-enabled').prop('checked'),
                plmField : $(this).find('.custom-erp-property-plm').val(),
                erpProperty : $(this).find('.custom-erp-property-erp').val()
            });
        });
        return result;
    }

    function splitList(value) {
        return value.split(',').map(function(entry) { return entry.trim(); }).filter(Boolean);
    }

    function saveEditor() {
        try {
            saveMapping(collectEditor());
            showMessage('ERP mapping saved and activated.', 'success');
        } catch(error) {
            showMessage(error.message, 'error');
        }
    }

    function resetMapping() {
        if(!window.confirm('Reset the ERP mapping to its built-in defaults?')) return;
        mapping = clone(DEFAULT_MAPPING);
        window.localStorage.removeItem(storageKey());
        installPayloadBuilder();
        closeEditor();
        openEditor();
        showMessage('Default mapping restored.', 'success');
    }

    function exportMapping() {
        let config;
        try { config = sanitize(collectEditor()); } catch(error) { return showMessage(error.message, 'error'); }
        let blob = new Blob([JSON.stringify(config, null, 2)], { type : 'application/json' });
        let link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'erp-interface-' + ((typeof window.tenant === 'string' && window.tenant) || 'mapping') + '.json';
        link.click();
        URL.revokeObjectURL(link.href);
    }

    function importMapping() {
        let input = $('<input type="file" accept="application/json,.json">');
        input.on('change', function() {
            let file = this.files && this.files[0];
            if(!file) return;
            let reader = new FileReader();
            reader.onload = function() {
                try {
                    saveMapping(JSON.parse(reader.result));
                    closeEditor();
                    openEditor();
                    showMessage('Mapping imported and activated.', 'success');
                } catch(error) {
                    showMessage(error.message, 'error');
                }
            };
            reader.readAsText(file);
        });
        input.trigger('click');
    }

    function showMessage(message, type) {
        $('#custom-erp-admin-message').removeClass('success error').addClass(type).text(message).show();
    }

    function closeEditor() {
        $('#custom-erp-admin-overlay').remove();
    }
})();
