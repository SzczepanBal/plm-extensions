(function() {

    const rawMaterialsWorkspaceId = 57;
    const addProcessWorkspaceId = 274;
    const addProcessWorkspacePageSize = 250;
    const rawMaterialTypeName = 'Surowiec';
    const rawMaterialTypeQueryValue = 'SUROWIEC';
    const erpStatusProxyUrl = '/plm/custom-erp-status';
    const assemblyIndexPLMDefaults = {
        productGroup : 'PCP',
        partType     : 'Z',
        kind         : 'Z',
        variant      : 'Standard',
        specification: 'Zozenie'
    };
    let addProcessWorkspaceItemsPromise = null;
    let addProcessWorkspaceItemsCache = [];

    function normalizeComparisonValue(value) {
        if(value === null || typeof value === 'undefined') return '';
        return value.toString().trim().replace(/\s+/g, ' ').toLowerCase();
    }

    function getMaterialValue(part) {
        if(!part || !part.details) return '';
        let material = part.details.MATERIAL || part.details['MATERIAL'];
        if(typeof material === 'string') material = material.trim();
        return (material || '').toString();
    }

    function getPartItemLink(part) {
        if(!part) return null;
        return part.link || part.__self__ || null;
    }

    function getMaterialValueFromItemDetails(itemDetails) {
        if(!itemDetails || !itemDetails.sections) return '';
        let material = getSectionFieldValue(itemDetails.sections, 'MATERIAL', '', null);
        if(typeof material === 'string') material = material.trim();
        return (material || '').toString();
    }

    function getItemWeightValue(part) {
        if(!part || !part.details) return NaN;

        let weightCandidates = [
            part.details.ITEM_WEIGHT,
            part.details['ITEM_WEIGHT'],
            part.details.WEIGHT,
            part.details['WEIGHT'],
            part.details.Weight,
            part.details['Weight']
        ];

        for(let candidate of weightCandidates) {
            let parsed = parseNumericValue(candidate);
            if(!Number.isNaN(parsed) && parsed > 0) {
                console.log('MBOM custom: EBOM ITEM_WEIGHT found on part details', {
                    ebomLink    : getPartItemLink(part),
                    partNumber  : getPartNumber(part),
                    rawValue    : candidate,
                    parsedValue : parsed
                });
                return parsed;
            }
        }

        console.log('MBOM custom: EBOM ITEM_WEIGHT missing on part details', {
            ebomLink   : getPartItemLink(part),
            partNumber : getPartNumber(part),
            candidates : weightCandidates
        });

        return NaN;
    }

    function getItemWeightValueFromItemDetails(itemDetails) {
        if(!itemDetails || !itemDetails.sections) return NaN;

        let candidates = ['ITEM_WEIGHT', 'WEIGHT', 'Weight'];
        for(let fieldId of candidates) {
            let value = getSectionFieldValue(itemDetails.sections, fieldId, '', null);
            let parsed = parseNumericValue(value);
            if(!Number.isNaN(parsed) && parsed > 0) {
                console.log('MBOM custom: EBOM ITEM_WEIGHT found in /plm/details fallback', {
                    fieldId     : fieldId,
                    rawValue    : value,
                    parsedValue : parsed
                });
                return parsed;
            }
        }

        console.log('MBOM custom: EBOM ITEM_WEIGHT missing in /plm/details fallback', {
            candidateFields : candidates
        });

        return NaN;
    }

    function fetchEBOMPartMaterialsFromDetails(ebomPartsList) {
        let requests = ebomPartsList.map(function(part) {
            return new Promise(function(resolve) {
                let link = getPartItemLink(part);
                if(!link) return resolve({ part: part, material: '', itemWeight: NaN });

                $.get('/plm/details', { link: link })
                    .done(function(response) {
                        let material = getMaterialValueFromItemDetails(response.data);
                        let itemWeight = getItemWeightValueFromItemDetails(response.data);
                        console.log('MBOM custom: fetched EBOM fallback details for raw material resolution', {
                            ebomLink    : link,
                            partNumber  : getPartNumber(part),
                            material    : material,
                            itemWeight  : itemWeight
                        });
                        resolve({
                            part       : part,
                            material   : material,
                            itemWeight : itemWeight
                        });
                    })
                    .fail(function() {
                        console.warn('MBOM custom: failed to fetch EBOM fallback details for raw material resolution', {
                            ebomLink   : link,
                            partNumber : getPartNumber(part)
                        });
                        resolve({ part: part, material: '', itemWeight: NaN });
                    });
            });
        });

        return Promise.all(requests);
    }

    function fetchEBOMItemWeightFromDetails(part) {
        let link = getPartItemLink(part);
        if(!link) return Promise.resolve(NaN);

        console.log('MBOM custom: fetching EBOM /plm/details specifically for ITEM_WEIGHT', {
            ebomLink   : link,
            partNumber : getPartNumber(part)
        });

        return $.get('/plm/details', { link: link })
            .then(function(response) {
                let itemWeight = getItemWeightValueFromItemDetails(response.data);
                console.log('MBOM custom: explicit EBOM ITEM_WEIGHT fetch finished', {
                    ebomLink    : link,
                    partNumber  : getPartNumber(part),
                    itemWeight  : itemWeight
                });
                return itemWeight;
            })
            .catch(function(error) {
                console.warn('MBOM custom: explicit EBOM ITEM_WEIGHT fetch failed', {
                    ebomLink   : link,
                    partNumber : getPartNumber(part),
                    error      : error
                });
                return NaN;
            });
    }

    function getPartNumber(part) {
        if(!part || !part.details) return '';
        let partNumber = part.details.NUMBER || part.details['NUMBER'] || part.details.ITEM_NUMBER || part.details['ITEM_NUMBER'] || part.details.partNumber || part.details['partNumber'];
        if(typeof partNumber === 'string') partNumber = partNumber.trim();
        return (partNumber || '').toString();
    }

    function getFirstMBOMComponentItem() {
        return $('#mbom-root-bom').children('.item').first();
    }

    function getFirstMBOMComponentHeader() {
        let firstComponent = getFirstMBOMComponentItem();
        if(firstComponent.length > 0) {
            return firstComponent.children('.item-head').first();
        }
        return $();
    }

    function getFirstManufacturingMBOMItem() {
        let elemMatch = $();

        $('#mbom-root-bom').children('.item').each(function() {
            let elemItem = $(this);
            if(elemItem.hasClass('process')) {
                elemMatch = elemItem;
                return false;
            }
        });

        return elemMatch;
    }

    function describeMBOMItem(elemItem) {
        if(!elemItem || elemItem.length === 0) return null;

        return {
            link       : elemItem.attr('data-link') || '',
            linkMBOM   : elemItem.attr('data-link-mbom') || '',
            number     : elemItem.attr('data-number') || elemItem.attr('data-number-db') || '',
            descriptor : elemItem.find('.item-head-descriptor').first().text() || elemItem.find('.item-title').first().text() || '',
            classes    : elemItem.attr('class') || ''
        };
    }

    function getFirstChildComponentHeader(elemItem) {
        if(!elemItem || elemItem.length === 0) return $();

        let firstChild = elemItem.children('.item-bom').children('.item').first();
        if(firstChild.length > 0) {
            return firstChild.children('.item-head').first();
        }

        return $();
    }

    function hasMBOMShortcut(elemItem) {
        if(!elemItem || elemItem.length === 0) return false;
        return elemItem.hasClass('assembly-index') ||
            elemItem.children('.item-head').find('.mbom-shortcut.icon-factory').length > 0;
    }

    function ensureMBOMShortcutIcons(elemItem) {
        if(!elemItem || elemItem.length === 0) return;

        let elemToggle = elemItem.children('.item-head').children('.item-toggle').first();
        if(elemToggle.length === 0) return;

        if(elemToggle.children('.mbom-shortcut.icon-factory').length === 0) {
            addMBOMShortcut(elemToggle);
        }

        // The collapse/expand pseudo-icon becomes a third grid item and hides
        // the open-in-new-tab shortcut. The factory shortcut handles toggling.
        elemToggle.removeClass('icon-collapse icon-expand');
    }

    function getMBOMShortcutHeader(elemItem) {
        if(!elemItem || elemItem.length === 0) return $();
        if(!hasMBOMShortcut(elemItem)) return $();
        return elemItem.children('.item-head').first();
    }

    function getFirstDirectChildMBOMHeader(elemItem) {
        if(!elemItem || elemItem.length === 0) return $();

        let elemMatch = $();

        elemItem.children('.item-bom').children('.item').each(function() {
            let elemChild = $(this);
            if(hasMBOMShortcut(elemChild)) {
                elemMatch = elemChild.children('.item-head').first();
                return false;
            }
        });

        return elemMatch;
    }

    function getFirstDirectProcessChildHeader(elemItem) {
        if(!elemItem || elemItem.length === 0) return $();

        let elemMatch = $();

        elemItem.children('.item-bom').children('.item').each(function() {
            let elemChild = $(this);
            if(elemChild.hasClass('process')) {
                elemMatch = elemChild.children('.item-head').first();
                return false;
            }
        });

        return elemMatch;
    }

    function getRawMaterialTargetKey(elemHeader) {
        if(!elemHeader || elemHeader.length === 0) return 'root';
        let elemItem = elemHeader.closest('.item');
        if(elemItem.length === 0) return 'root';
        return elemItem.attr('data-link') || elemItem.attr('data-number-db') || elemItem.attr('data-number') || 'root';
    }

    function getMBOMItemForEBOMPart(part) {
        let ebomLink = getPartItemLink(part);
        if(!ebomLink) {
            console.warn('MBOM custom: EBOM part link missing for part', part);
            return $();
        }

        let elemEBOMItem = $('#ebom').find('.item[data-link="' + ebomLink + '"]').first();
        let mbomLinkFromApp = '';

        if(elemEBOMItem.length > 0) {
            mbomLinkFromApp = elemEBOMItem.attr('data-mbom') || '';
        }

        if(isBlank(mbomLinkFromApp) && part && part.mbom && part.mbom.link) {
            mbomLinkFromApp = part.mbom.link;
        }

        if(!isBlank(mbomLinkFromApp)) {
            let elemMBOMByAppLink = $('#mbom').find('.item[data-link="' + mbomLinkFromApp + '"]').first();
            if(elemMBOMByAppLink.length === 0) {
                elemMBOMByAppLink = $('#mbom').find('.item[data-link-mbom="' + mbomLinkFromApp + '"]').first();
            }

            if(elemMBOMByAppLink.length > 0) {
                console.log('MBOM custom: matched MBOM item via EBOM MBOM link from app state', {
                    ebomLink      : ebomLink,
                    mbomLink      : mbomLinkFromApp,
                    targetItem    : describeMBOMItem(elemMBOMByAppLink)
                });
                return elemMBOMByAppLink;
            }

            console.warn('MBOM custom: EBOM item exposes MBOM link but no MBOM DOM node matched it', {
                ebomLink   : ebomLink,
                mbomLink   : mbomLinkFromApp
            });
        }

        let elemMBOMItem = $('#mbom').find('.item[data-ebom="' + ebomLink + '"]').first();
        if(elemMBOMItem.length === 0) {
            elemMBOMItem = $('#mbom').find('.item[data-ebom-root="' + ebomLink + '"]').first();
        }
        if(elemMBOMItem.length === 0) {
            elemMBOMItem = $('#mbom').find('.item[data-link-ebom="' + ebomLink + '"]').first();
        }

        if(elemMBOMItem.length === 0) {
            let mbomLink = elemEBOMItem.attr('data-mbom');
            if(!isBlank(mbomLink)) {
                elemMBOMItem = $('#mbom').find('.item[data-link="' + mbomLink + '"]').first();
            }
        }

        if(elemMBOMItem.length === 0) {
            let elemMatchedChild = $();

            $('#mbom').find('.item[data-link-ebom], .item[data-ebom]').each(function() {
                let elemCandidate = $(this);
                let linkEBOM = elemCandidate.attr('data-link-ebom') || elemCandidate.attr('data-ebom') || '';

                if(normalizePLMLink(linkEBOM) === normalizePLMLink(ebomLink)) {
                    elemMatchedChild = elemCandidate;
                    return false;
                }
            });

            if(elemMatchedChild.length > 0) {
                elemMBOMItem = elemMatchedChild;
            }
        }

        if(elemMBOMItem.length === 0) {
            console.warn('MBOM custom: could not find matching MBOM item for EBOM link', ebomLink);
            console.log('MBOM custom: available MBOM EBOM-link candidates', $('#mbom').find('.item[data-link-ebom], .item[data-ebom], .item[data-ebom-root]').map(function() {
                let elemItem = $(this);
                return {
                    link       : elemItem.attr('data-link') || '',
                    linkEBOM   : elemItem.attr('data-link-ebom') || '',
                    ebom       : elemItem.attr('data-ebom') || '',
                    ebomRoot   : elemItem.attr('data-ebom-root') || '',
                    classes    : elemItem.attr('class') || '',
                    descriptor : elemItem.find('.item-head-descriptor').first().text() || ''
                };
            }).get());
            return $();
        }

        console.log('MBOM custom: matched MBOM item for EBOM link', {
            ebomLink   : ebomLink,
            targetItem : describeMBOMItem(elemMBOMItem),
            linkEBOM   : elemMBOMItem.attr('data-link-ebom') || '',
            ebom       : elemMBOMItem.attr('data-ebom') || '',
            ebomRoot   : elemMBOMItem.attr('data-ebom-root') || ''
        });
        return elemMBOMItem;
    }

    function getRawMaterialTargetHeader(part) {
        let ebomLink = getPartItemLink(part);
        let elemMBOMItem = getMBOMItemForEBOMPart(part);
        if(!elemMBOMItem || elemMBOMItem.length === 0) {
            console.warn('MBOM custom: raw material skipped because no MBOM item matched the EBOM link', {
                ebomLink  : ebomLink,
                material  : getMaterialValue(part),
                partNumber: getPartNumber(part)
            });
            return $();
        }

        let mbomLink = elemMBOMItem.attr('data-link') || elemMBOMItem.attr('data-link-mbom') || '';

        let elemProcessHeader = getFirstDirectProcessChildHeader(elemMBOMItem);
        if(elemProcessHeader.length > 0) {
            ensureInlineSubMBOMContainer(elemProcessHeader.closest('.item'));
            console.log('MBOM custom: using first direct process child of linked MBOM item as raw material target', {
                ebomLink      : ebomLink,
                mbomLink      : mbomLink,
                material      : getMaterialValue(part),
                linkedTarget  : describeMBOMItem(elemMBOMItem),
                processTarget : describeMBOMItem(elemProcessHeader.closest('.item'))
            });
            return elemProcessHeader;
        }

        if(elemMBOMItem.hasClass('process')) {
            let elemOwnHeader = elemMBOMItem.children('.item-head').first();
            if(elemOwnHeader.length > 0) {
                ensureInlineSubMBOMContainer(elemMBOMItem);
                console.log('MBOM custom: using linked process node itself as raw material target', {
                    ebomLink      : ebomLink,
                    mbomLink      : mbomLink,
                    material      : getMaterialValue(part),
                    processTarget : describeMBOMItem(elemMBOMItem)
                });
                return elemOwnHeader;
            }
        }

        console.warn('MBOM custom: raw material skipped because linked MBOM item has no direct process child after expansion', {
            ebomLink   : ebomLink,
            mbomLink   : mbomLink,
            material   : getMaterialValue(part),
            partNumber : getPartNumber(part),
            targetItem : describeMBOMItem(elemMBOMItem)
        });
        return $();
    }

    function getDescendantItemLinks(elemItem) {
        let existingLinks = new Set();
        if(!elemItem || elemItem.length === 0) return existingLinks;

        elemItem.find('.item').each(function() {
            let link = $(this).attr('data-link');
            if(!isBlank(link)) existingLinks.add(link);
        });

        let ownLink = elemItem.attr('data-link');
        if(!isBlank(ownLink)) existingLinks.add(ownLink);

        return existingLinks;
    }

    function getDirectChildItemLinks(elemHeader) {
        let existingLinks = new Set();
        if(!elemHeader || elemHeader.length === 0) return existingLinks;

        elemHeader.next().children('.item').each(function() {
            let link = $(this).attr('data-link');
            if(!isBlank(link)) existingLinks.add(link);
        });

        return existingLinks;
    }

    function logEBOMMaterials(ebomPartsList) {
        console.group('MBOM custom: EBOM parts and their MATERIAL values');
        let partsWithMaterial = 0;

        for(let index = 0; index < ebomPartsList.length; index++) {
            let part = ebomPartsList[index];
            let material = getMaterialValue(part);
            let partNumber = getPartNumber(part) || part.title || part.descriptor || 'Unknown';
            if(!isBlank(material)) partsWithMaterial++;
            console.log(partNumber + ' | ' + (material || 'None'));

            if(index < 5 && isBlank(material)) {
                console.debug('MBOM custom: EBOM part details keys:', Object.keys(part.details || {}));
                if(Array.isArray(part.fields)) {
                    console.debug('MBOM custom: EBOM part fields:', part.fields.map(function(field) {
                        return { fieldId: field.fieldId, name: field.name, displayName: field.displayName, value: field.value };
                    }));
                }
            }
        }

        if(partsWithMaterial === 0) {
            console.warn('MBOM custom: No MATERIAL values were found in the loaded EBOM parts. This usually means MATERIAL is not part of the configured EBOM BOM view.');
            if(typeof wsEBOM !== 'undefined' && Array.isArray(wsEBOM.viewFields)) {
                console.debug('MBOM custom: Configured EBOM view fields:', wsEBOM.viewFields.map(function(field) {
                    return { fieldId: field.fieldId, name: field.name, displayName: field.displayName };
                }));
            }

            fetchEBOMPartMaterialsFromDetails(ebomPartsList).then(function(results) {
                console.group('MBOM custom: EBOM part MATERIAL fallback from item details');
                for(let result of results) {
                    let part = result.part;
                    let partNumber = getPartNumber(part) || part.title || part.descriptor || 'Unknown';
                    console.log(partNumber + ' | ' + (result.material || 'None'));
                }
                console.groupEnd();
            });
        }

        console.groupEnd();
    }

    function getMaterialsFromEBOMParts(ebomPartsList) {
        let materials = getUniqueMaterialsFromEBOMParts(ebomPartsList);
        if(materials.length > 0) {
            return Promise.resolve(materials);
        }

        console.info('MBOM custom: no MATERIAL values found in EBOM; fetching fallback values from item details.');

        return fetchEBOMPartMaterialsFromDetails(ebomPartsList).then(function(results) {
            let fallbackMaterials = new Set();
            results.forEach(function(result) {
                if(!isBlank(result.material)) {
                    fallbackMaterials.add(result.material);
                }
            });
            return Array.from(fallbackMaterials);
        });
    }

    function searchRawMaterialItems(material) {
        let encodedMaterial = encodeURIComponent(material);
        let query = 'ITEM_DETAILS:TITLE%3D%22' + encodedMaterial + '%22';
        let params = {
            wsId   : rawMaterialsWorkspaceId,
            limit  : 100,
            offset : 0,
            query  : query
        };

        console.log('MBOM custom: raw material title search started', {
            workspaceId : rawMaterialsWorkspaceId,
            material    : material,
            query       : query
        });

        return new Promise(function(resolve) {
            $.get('/plm/search-bulk', params)
                .done(function(response) {
                    let items = (response && response.data && response.data.items) ? response.data.items : [];
                    let filteredItems = items.filter(function(item) {
                        return itemLooksLikeMatchingRawMaterial(item, material);
                    });

                    console.log('MBOM custom: raw material title search finished', {
                        material    : material,
                        totalResults: items.length,
                        titleMatches: filteredItems.length
                    });

                    if(items.length > 0) {
                        console.log('MBOM custom: raw material first search result sample', {
                            material   : material,
                            title      : getSearchItemFieldValue(items[0], 'TITLE'),
                            descriptor : getSearchItemFieldValue(items[0], 'DESCRIPTOR'),
                            link       : getSearchItemLink(items[0]),
                            rawItem    : items[0]
                        });
                    }

                    resolve({ material: material, items: filteredItems, query: query });
                })
                .fail(function(jqXHR, textStatus, errorThrown) {
                    console.warn('MBOM custom: raw material title search failed', {
                        material   : material,
                        query      : query,
                        status     : jqXHR ? jqXHR.status : null,
                        textStatus : textStatus || '',
                        error      : errorThrown || ''
                    });
                    resolve({ material: material, items: [], query: query });
                });
        });
    }

    function getSearchItemLink(item) {
        if(!item) return '';
        if(item.item && item.item.link) return item.item.link;
        if(item.__self__) return item.__self__;
        return '';
    }

    function getSearchItemFieldValue(item, fieldId) {
        if(!item) return '';

        if(fieldId === 'TITLE') {
            if(typeof item.title === 'string') return item.title;
            if(item.item && typeof item.item.title === 'string') return item.item.title;
        }

        if(fieldId === 'DESCRIPTOR') {
            if(typeof item.descriptor === 'string') return item.descriptor;
            if(item.item && typeof item.item.descriptor === 'string') return item.item.descriptor;
        }

        if(typeof item[fieldId] === 'string') return item[fieldId];
        if(item.item && typeof item.item[fieldId] === 'string') return item.item[fieldId];
        if(!Array.isArray(item.fields)) return '';

        let match = item.fields.find(function(field) {
            return field && (field.id === fieldId || field.fieldId === fieldId || field.name === fieldId);
        });

        if(!match) return '';
        if(typeof match.value === 'string') return match.value;
        if(match.value && typeof match.value.title === 'string') return match.value.title;
        if(match.fieldData && typeof match.fieldData.value === 'string') return match.fieldData.value;
        return match.value || '';
    }

    function itemLooksLikeMatchingRawMaterial(item, material) {
        if(!item) return false;

        let normalizedMaterial = normalizeComparisonValue(material);
        let title = getSearchItemFieldValue(item, 'TITLE') || (item.item && item.item.title) || '';
        let normalizedTitle = normalizeComparisonValue(title);

        if(normalizedTitle === normalizedMaterial) return true;

        let numberedTitlePrefix = normalizedMaterial + ' - ';
        if(normalizedTitle.indexOf(numberedTitlePrefix) !== 0) return false;

        let itemNumberSuffix = normalizedTitle.substring(numberedTitlePrefix.length).trim();
        return /^s\d+$/.test(itemNumberSuffix);
    }

    function chooseRawMaterialItem(material, items) {
        if(!Array.isArray(items) || items.length === 0) return null;

        let exactMatches = items.filter(function(item) {
            return itemLooksLikeMatchingRawMaterial(item, material);
        });

        if(exactMatches.length > 1) {
            console.warn('MBOM custom: multiple matching raw material TITLE values found, using first result', {
                material : material,
                matches  : exactMatches.map(function(item) {
                    return {
                        link       : getSearchItemLink(item),
                        title      : getSearchItemFieldValue(item, 'TITLE') || (item.item && item.item.title) || '',
                        descriptor : getSearchItemFieldValue(item, 'DESCRIPTOR') || (item.item && item.item.descriptor) || ''
                    };
                })
            });
        }

        if(exactMatches.length > 0) return exactMatches[0];
        return null;
    }

    function parseNumericValue(value) {
        if(typeof value === 'number') return Number.isFinite(value) ? value : NaN;
        if(typeof value !== 'string') return NaN;

        let normalized = value.trim();
        if(normalized === '') return NaN;

        normalized = normalized.replace(/\s+/g, '');
        normalized = normalized.replace(',', '.');

        let parsed = parseFloat(normalized);
        return Number.isNaN(parsed) ? NaN : parsed;
    }

    function isKilogramUnitValue(value) {
        if(value === null || typeof value === 'undefined') return false;

        let normalized = normalizeComparisonValue(value);
        return normalized === 'kilogram' || normalized === 'kilograms' || normalized === 'kg';
    }

    function getRawMaterialUnitOfMeasure(item) {
        if(!item) return '';

        let unitCandidates = [
            'UNIT_OF_MEASURE',
            'UOM',
            'UNIT',
            'BOM_UOM',
            'ITEM_UOM'
        ];

        for(let fieldId of unitCandidates) {
            let value = getSearchItemFieldValue(item, fieldId);
            if(!isBlank(value)) return value;
        }

        return '';
    }

    function getRawMaterialWeight(item) {
        if(!item) return NaN;

        let weightCandidates = [
            'ITEM_WEIGHT',
            'WEIGHT'
        ];

        for(let fieldId of weightCandidates) {
            let value = getSearchItemFieldValue(item, fieldId);
            let parsed = parseNumericValue(value);
            if(!Number.isNaN(parsed) && parsed > 0) return parsed;
        }

        return NaN;
    }

    function normalizeMBOMUnitOfMeasureValue(value) {
        if(value === null || typeof value === 'undefined') return '';
        if(typeof value === 'string') return value.trim();
        if(typeof value === 'number') return String(value);
        if(value && typeof value.title === 'string') return value.title.trim();
        if(value && typeof value.value === 'string') return value.value.trim();
        return '';
    }

    function getMBOMPartUnitOfMeasure(part) {
        if(!part) return '';

        let fieldIds = (typeof config !== 'undefined' && config.workspaceMBOM && config.workspaceMBOM.fieldIDs)
            ? config.workspaceMBOM.fieldIDs
            : {};

        let candidateIds = [
            fieldIds.unitOfMeasure,
            fieldIds.uom,
            'UNIT_OF_MEASURE',
            'UOM',
            'UNIT',
            'BOM_UOM',
            'ITEM_UOM'
        ].filter(Boolean);

        if(Array.isArray(part.fields)) {
            for(let fieldId of candidateIds) {
                let bomValue = getBOMPartFieldValue(part, fieldId);
                let normalizedBOMValue = normalizeMBOMUnitOfMeasureValue(bomValue);
                if(!isBlank(normalizedBOMValue)) return normalizedBOMValue;
            }
        }

        if(part.details) {
            for(let fieldId of candidateIds) {
                let detailsValue = normalizeMBOMUnitOfMeasureValue(part.details[fieldId]);
                if(!isBlank(detailsValue)) return detailsValue;
            }

            let normalizedCandidates = candidateIds.map(function(fieldId) {
                return String(fieldId).toLowerCase().replace(/[^a-z0-9]/g, '');
            });

            for(let key of Object.keys(part.details)) {
                let normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
                if(normalizedCandidates.includes(normalizedKey)) {
                    let detailsValue = normalizeMBOMUnitOfMeasureValue(part.details[key]);
                    if(!isBlank(detailsValue)) return detailsValue;
                }
            }
        }

        return '';
    }

    function getItemDetailsUnitOfMeasure(sections) {
        if(!Array.isArray(sections)) return '';

        let fieldIds = (typeof config !== 'undefined' && config.workspaceMBOM && config.workspaceMBOM.fieldIDs)
            ? config.workspaceMBOM.fieldIDs
            : {};

        let candidateIds = [
            fieldIds.unitOfMeasure,
            fieldIds.uom,
            'UNIT_OF_MEASURE',
            'UOM',
            'UNIT',
            'BOM_UOM',
            'ITEM_UOM'
        ].filter(Boolean);

        for(let fieldId of candidateIds) {
            let value = getSectionFieldValue(sections, fieldId, '', null);
            let normalizedValue = normalizeMBOMUnitOfMeasureValue(value);
            if(!isBlank(normalizedValue)) return normalizedValue;
        }

        return '';
    }

    function ensureMBOMUnitOfMeasureStyles() {
        if($('#mbom-uom-styles').length > 0) return;

        $('<style></style>')
            .attr('id', 'mbom-uom-styles')
            .html(
                '#mbom .item > .item-head > .item-qty.with-uom{' +
                    'display:flex;align-items:center;gap:4px;max-width:84px;min-width:84px;width:84px;padding:0 6px;' +
                '}' +
                '#mbom .item > .item-head > .item-qty.with-uom > .item-qty-input{' +
                    'width:32px;padding:3px 4px;' +
                '}' +
                '#mbom .item > .item-head > .item-qty > .item-qty-uom{' +
                    'color:var(--color-gray-300);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
                '}'
            )
            .appendTo('head');
    }

    function decorateMBOMQuantityWithUnit(elemNode, node, bomType) {
        if(bomType !== 'mbom' || !elemNode || elemNode.length === 0 || !node || Number(node.level) === 0) return;

        let unitOfMeasure = normalizeMBOMUnitOfMeasureValue(node.unitOfMeasure || node.uom);
        if(isBlank(unitOfMeasure)) return;

        let elemQty = elemNode.children('.item-head').children('.item-qty').first();
        if(elemQty.length === 0) return;

        ensureMBOMUnitOfMeasureStyles();
        elemQty.addClass('with-uom');
        elemQty.attr('title', 'Quantity (' + unitOfMeasure + ')');

        let elemLabel = elemQty.children('.item-qty-uom').first();
        if(elemLabel.length === 0) {
            elemLabel = $('<span></span>').appendTo(elemQty).addClass('item-qty-uom');
        }

        elemLabel.text(unitOfMeasure);
    }

    function getRawMaterialInsertQuantity(entry, item) {
        let part = entry ? entry.part : null;
        let defaultQuantity = parseNumericValue(part && part.quantity);
        if(Number.isNaN(defaultQuantity) || defaultQuantity <= 0) defaultQuantity = 1;

        let unitOfMeasure = getRawMaterialUnitOfMeasure(item);
        console.log('MBOM custom: raw material quantity decision started', {
            ebomLink         : getPartItemLink(part),
            partNumber       : getPartNumber(part),
            material         : entry ? entry.material : '',
            ebomQuantity     : defaultQuantity,
            ebomItemWeight   : entry ? entry.itemWeight : NaN,
            rawMaterialLink  : getSearchItemLink(item),
            rawMaterialUOM   : unitOfMeasure
        });

        let ebomWeight = entry ? entry.itemWeight : NaN;
        if(!Number.isNaN(ebomWeight) && ebomWeight > 0) {
            console.log('MBOM custom: using EBOM ITEM_WEIGHT for raw material quantity (test mode, no UOM check)', {
                ebomLink      : getPartItemLink(part),
                unitOfMeasure : unitOfMeasure,
                itemWeight    : ebomWeight
            });
            return Promise.resolve(ebomWeight);
        }

        return fetchEBOMItemWeightFromDetails(part).then(function(fallbackWeight) {
            if(!Number.isNaN(fallbackWeight) && fallbackWeight > 0) {
                if(entry) entry.itemWeight = fallbackWeight;
                console.log('MBOM custom: using explicit EBOM /plm/details ITEM_WEIGHT for raw material quantity (test mode, no UOM check)', {
                    ebomLink      : getPartItemLink(part),
                    unitOfMeasure : unitOfMeasure,
                    itemWeight    : fallbackWeight
                });
                return fallbackWeight;
            }

            console.warn('MBOM custom: kilogram raw material is missing usable EBOM ITEM_WEIGHT, falling back to quantity 1', {
                ebomLink        : getPartItemLink(part),
                itemLink        : getSearchItemLink(item),
                unitOfMeasure   : unitOfMeasure,
                defaultQuantity : defaultQuantity
            });

            return 1;
        });
    }

    function setRawMaterialQuantity(elemHeader, link, quantity) {
        let elemItem = getDirectChildItemByLink(elemHeader, link);
        if(elemItem.length === 0) return false;

        let elemQty = elemItem.find('.item-qty-input').first();
        if(elemQty.length === 0) return false;

        let nextQty = parseFloat(quantity);
        if(Number.isNaN(nextQty) || nextQty <= 0) nextQty = 1;

        elemQty.val(nextQty);
        elemItem.attr('data-instance-qty', nextQty);
        elemItem.attr('data-qty', nextQty);

        if(typeof setBOMTotalQuantities === 'function') {
            let root = elemItem.attr('data-root');
            if(!isBlank(root)) setBOMTotalQuantities(root);
        }

        console.log('MBOM custom: raw material quantity set', {
            link     : link,
            quantity : nextQty
        });

        return true;
    }

    function waitForDirectChildItem(elemHeader, link, attempt) {
        let elemItem = getDirectChildItemByLink(elemHeader, link);
        if(elemItem.length > 0) return Promise.resolve(elemItem);

        let nextAttempt = typeof attempt === 'number' ? attempt + 1 : 1;
        if(nextAttempt > 10) return Promise.resolve($());

        return new Promise(function(resolve) {
            setTimeout(function() {
                resolve(waitForDirectChildItem(elemHeader, link, nextAttempt));
            }, 100);
        });
    }

    function getExistingChildLinks(elemHeader) {
        let existingLinks = new Set();
        if(!elemHeader || elemHeader.length === 0) return existingLinks;

        elemHeader.next().children('.item').each(function() {
            let link = $(this).attr('data-link');
            if(!isBlank(link)) existingLinks.add(link);
        });

        return existingLinks;
    }

    function normalizePLMLink(link) {
        if(isBlank(link)) return '';

        let normalized = String(link).trim();
        normalized = normalized.replace(/^https?:\/\/[^/]+/i, '');

        let workspaceMatch = normalized.match(/\/api\/v3\/workspaces\/\d+\/items\/\d+/i);
        if(workspaceMatch) return workspaceMatch[0].toLowerCase();

        return normalized.toLowerCase();
    }

    function getPLMItemLevelLink(link) {
        if(isBlank(link)) return '';

        let normalized = String(link).trim().replace(/^https?:\/\/[^/]+/i, '');
        let workspaceMatch = normalized.match(/\/api\/v3\/workspaces\/\d+\/items\/\d+/i);

        return workspaceMatch ? workspaceMatch[0] : normalized;
    }

    function getDirectChildItemByLink(elemHeader, link) {
        if(!elemHeader || elemHeader.length === 0 || isBlank(link)) return $();

        let elemMatch = $();
        let normalizedLink = normalizePLMLink(link);

        elemHeader.next().children('.item').each(function() {
            let elemItem = $(this);
            let itemLink = normalizePLMLink(elemItem.attr('data-link'));
            let itemMBOMLink = normalizePLMLink(elemItem.attr('data-link-mbom'));

            if(itemLink === normalizedLink || itemMBOMLink === normalizedLink) {
                elemMatch = elemItem;
                return false;
            }
        });

        return elemMatch;
    }

    function incrementRawMaterialQuantity(elemHeader, link, amount) {
        let elemItem = getDirectChildItemByLink(elemHeader, link);
        if(elemItem.length === 0) return false;

        let elemQty = elemItem.find('.item-qty-input').first();
        if(elemQty.length === 0) return false;

        let currentQty = parseFloat(elemQty.val());
        if(Number.isNaN(currentQty)) currentQty = parseFloat(elemItem.attr('data-qty'));
        if(Number.isNaN(currentQty)) currentQty = 0;

        let increment = parseFloat(amount);
        if(Number.isNaN(increment) || increment <= 0) increment = 1;

        let nextQty = currentQty + increment;

        elemQty.val(nextQty);
        elemItem.attr('data-instance-qty', nextQty);

        if(typeof setBOMTotalQuantities === 'function') {
            let root = elemItem.attr('data-root');
            if(!isBlank(root)) setBOMTotalQuantities(root);
        }

        return true;
    }

    function getAddProcessItemLink(item) {
        if(!item) return '';
        if(typeof item.__self__ === 'string') return item.__self__;
        if(item.item && typeof item.item.link === 'string') return item.item.link;
        if(typeof item.link === 'string') return item.link;
        return '';
    }

    function getAddProcessItemTitle(item) {
        if(!item) return '';
        if(typeof item.title === 'string') return item.title;
        if(typeof item.descriptor === 'string') return item.descriptor;
        if(item.item && typeof item.item.title === 'string') return item.item.title;
        if(item.item && typeof item.item.descriptor === 'string') return item.item.descriptor;

        if(Array.isArray(item.fields)) {
            for(let field of item.fields) {
                if(!field) continue;
                let fieldId = field.id || field.fieldId || field.name || '';
                if(['TITLE', 'DESCRIPTOR', 'NAME'].includes(fieldId)) {
                    let value = field.value;
                    if(typeof value === 'string' && value.trim() !== '') return value.trim();
                    if(value && typeof value.title === 'string' && value.title.trim() !== '') return value.title.trim();
                }
            }
        }

        let fallbackCode = getAddProcessItemCode(item);
        if(fallbackCode !== '') return fallbackCode;
        return '';
    }

    function getAddProcessItemCode(item) {
        if(!item) return '';

        let directCandidates = [
            item.code,
            item.CODE,
            item.number,
            item.NUMBER,
            item.partNumber,
            item.ITEM_NUMBER
        ];

        for(let candidate of directCandidates) {
            if(typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
        }

        if(Array.isArray(item.fields)) {
            for(let field of item.fields) {
                if(!field) continue;
                let fieldId = field.id || field.fieldId || field.name || '';
                if(['CODE', 'NUMBER', 'ITEM_NUMBER', 'PART_NUMBER'].includes(fieldId)) {
                    let value = field.value;
                    if(typeof value === 'string' && value.trim() !== '') return value.trim();
                    if(value && typeof value.title === 'string' && value.title.trim() !== '') return value.title.trim();
                }
            }
        }

        return '';
    }

    function fetchAddProcessWorkspaceItems(offset, collectedItems) {
        let nextOffset = Number(offset) || 0;
        let items = Array.isArray(collectedItems) ? collectedItems : [];

        return $.get('/plm/items', {
            wsId   : addProcessWorkspaceId,
            query  : '*',
            limit  : addProcessWorkspacePageSize,
            offset : nextOffset,
            bulk   : false
        }).then(function(response) {
            let pageItems = (response && response.data && Array.isArray(response.data.items)) ? response.data.items : [];
            items = items.concat(pageItems);

            if(pageItems.length < addProcessWorkspacePageSize) return items;
            return fetchAddProcessWorkspaceItems(nextOffset + addProcessWorkspacePageSize, items);
        });
    }

    function searchAddProcessWorkspaceItems(offset, collectedItems) {
        let nextOffset = Number(offset) || 0;
        let items = Array.isArray(collectedItems) ? collectedItems : [];

        return $.get('/plm/search-bulk', {
            wsId   : addProcessWorkspaceId,
            limit  : addProcessWorkspacePageSize,
            offset : nextOffset,
            query  : '*',
            bulk   : false
        }).then(function(response) {
            let pageItems = (response && response.data && Array.isArray(response.data.items)) ? response.data.items : [];
            items = items.concat(pageItems);

            if(pageItems.length < addProcessWorkspacePageSize) return items;
            return searchAddProcessWorkspaceItems(nextOffset + addProcessWorkspacePageSize, items);
        });
    }

    function loadAddProcessWorkspaceItems() {
        if(addProcessWorkspaceItemsPromise) return addProcessWorkspaceItemsPromise;

        addProcessWorkspaceItemsPromise = fetchAddProcessWorkspaceItems(0, [])
            .then(function(items) {
                if(items.length > 0) return items;

                console.warn('MBOM custom: /plm/items returned no Add Process records, retrying with search-bulk', {
                    workspaceId : addProcessWorkspaceId
                });
                return searchAddProcessWorkspaceItems(0, []);
            })
            .then(function(items) {
                addProcessWorkspaceItemsCache = items.slice().sort(function(a, b) {
                    let aTitle = getAddProcessItemTitle(a).toLowerCase();
                    let bTitle = getAddProcessItemTitle(b).toLowerCase();
                    return aTitle.localeCompare(bTitle);
                });

                console.log('MBOM custom: loaded Add Process workspace items', {
                    workspaceId : addProcessWorkspaceId,
                    itemCount   : addProcessWorkspaceItemsCache.length
                });

                return addProcessWorkspaceItemsCache;
            })
            .catch(function(error) {
                addProcessWorkspaceItemsPromise = null;
                addProcessWorkspaceItemsCache = [];
                console.warn('MBOM custom: failed to load Add Process workspace items', {
                    workspaceId : addProcessWorkspaceId,
                    error       : error
                });
                throw error;
            });

        return addProcessWorkspaceItemsPromise;
    }

    function getSelectedAddProcessItem() {
        let elemSelect = $('#mbom-add-name');
        if(elemSelect.length === 0) return null;

        let selectedLink = elemSelect.val();
        if(isBlank(selectedLink)) return null;

        for(let item of addProcessWorkspaceItemsCache) {
            if(normalizePLMLink(getAddProcessItemLink(item)) === normalizePLMLink(selectedLink)) {
                return item;
            }
        }

        return null;
    }

    function updateAddProcessSelectionDetails() {
        let elemCode = $('#mbom-add-code');

        if(elemCode.length === 0) return;
        elemCode.val(getNextProcessCode());
    }

    function getNextProcessCode() {
        let highestCode = 0;
        let elemRootBOM = $('#mbom-tree').children().first().children('.item-bom').first();

        elemRootBOM.children('.item.process').each(function() {
            let elemItem = $(this);
            let value = elemItem.attr('data-code') || elemItem.find('.item-code').first().text() || '';
            let numericValue = parseInt(String(value).trim(), 10);

            if(!Number.isNaN(numericValue) && numericValue > highestCode) highestCode = numericValue;
        });

        return (Math.floor(highestCode / 10) + 1) * 10;
    }

    function renderAddProcessWorkspaceOptions(items) {
        let elemSelect = $('#mbom-add-name');
        if(elemSelect.length === 0) return;

        elemSelect.empty();
        $('<option></option>').appendTo(elemSelect)
            .attr('value', '')
            .html('Operacje');

        items.forEach(function(item) {
            let link = getAddProcessItemLink(item);
            let title = getAddProcessItemTitle(item);
            if(isBlank(link)) return;

            let code = getAddProcessItemCode(item);
            let optionTitle = isBlank(title) ? link.split('/').pop() : title;
            let optionLabel = isBlank(code) ? optionTitle : (optionTitle + ' [' + code + ']');

            $('<option></option>').appendTo(elemSelect)
                .attr('value', link)
                .attr('data-code', code)
                .html(optionLabel);
        });

        updateAddProcessSelectionDetails();
    }

    function setupAddProcessPicker() {
        let elemContainer = $('#mbom-add-process');
        let elemName = $('#mbom-add-name');
        let elemCode = $('#mbom-add-code');

        if(elemContainer.length === 0 || elemName.length === 0) return;

        $('#mbom-add-text').text('Dodaj operacje');
        $('#mbom-add-button').text('Dodaj');

        if(!elemName.is('select')) {
            let elemSelect = $('<select></select>')
                .attr('id', 'mbom-add-name')
                .attr('title', 'Select an existing process from workspace ' + addProcessWorkspaceId)
                .css({
                    background    : 'var(--color-surface-level-1)',
                    borderColor   : 'var(--color-surface-level-4)',
                    height        : '28px',
                    padding       : '0px 16px'
                });

            elemSelect.insertBefore(elemName);
            elemName.remove();
            elemName = elemSelect;
        }

        elemName.off('change.custom-add-process').on('change.custom-add-process', function() {
            updateAddProcessSelectionDetails();
        });

        if(elemCode.length > 0) {
            elemCode.attr('readonly', 'readonly');
            elemCode.attr('placeholder', 'Kod automatyczny');
            elemCode.hide();
        }

        $('#mbom-add-qty').hide();

        elemContainer.attr('title', 'Process list is loaded from workspace ' + addProcessWorkspaceId);

        renderAddProcessWorkspaceOptions(addProcessWorkspaceItemsCache);

        loadAddProcessWorkspaceItems().then(function(items) {
            renderAddProcessWorkspaceOptions(items);
            elemContainer.attr('title', 'Loaded ' + items.length + ' process items from workspace ' + addProcessWorkspaceId);
        }).catch(function() {
            showErrorMessage('Add Process', 'Could not load items from workspace ' + addProcessWorkspaceId + '.');
        });
    }

    function getContainingMBOMTitle() {
        let elemRoot = $('#mbom-tree').children('.item').first();
        let title = getERPTechnologyDescriptor(elemRoot);

        if(!isBlank(title)) return Promise.resolve(title);

        let rootLink = (typeof links !== 'undefined' && links) ? links.mbom : '';
        if(isBlank(rootLink)) return Promise.resolve('');

        return $.get('/plm/details', { link : rootLink }).then(function(response) {
            let details = response && response.data ? response.data : {};
            return getSectionFieldValue(details.sections || [], config.workspaceMBOM.fieldIDs.title, details.title || '');
        }).catch(function() {
            return '';
        });
    }

    function promoteAssemblyIndexToMBOMBranch(elemItem) {
        if(!elemItem || elemItem.length === 0) return;

        elemItem
            .removeClass('leaf')
            .addClass('item-has-bom')
            .addClass('assembly-index')
            .attr('data-link-mbom', elemItem.attr('data-link'));

        let elemHeader = elemItem.children('.item-head').first();
        let elemToggle = elemHeader.children('.item-toggle').first();
        let elemIcon = elemHeader.children('.item-icon').first();

        elemIcon
            .removeClass('icon-wrench')
            .addClass('radio-process')
            .attr('title', 'Indeks montażowy/złożeniowy');

        ensureInlineSubMBOMContainer(elemItem);

        if(elemToggle.length > 0 && !elemToggle.hasClass('icon-collapse') && !elemToggle.hasClass('icon-expand')) {
            addBOMToggle(elemToggle);
        }

        ensureMBOMShortcutIcons(elemItem);

        elemItem.off('click.custom-assembly-index').on('click.custom-assembly-index', function(e) {
            e.stopPropagation();
            e.preventDefault();
            selectProcess($(this));
        });

        selectProcess(elemItem);
    }

    function createAssemblyIndex() {
        let elemButton = $('#mbom-add-assembly-index');
        if(elemButton.hasClass('disabled')) return;

        elemButton.addClass('disabled').text('Tworzenie...');
        $('#overlay').show();

        getContainingMBOMTitle().then(function(containingTitle) {
            if(isBlank(containingTitle)) throw new Error('Nie udało się odczytać nazwy nadrzędnego MBOM.');

            let assemblyIndexTitle = 'indeks złożeniowy ' + containingTitle;

            let typeValue = (typeof config !== 'undefined' && config.mbomRoot)
                ? config.mbomRoot.typeValue
                : '';

            if(isBlank(typeValue)) throw new Error('Brak konfiguracji typu Manufacturing (config.mbomRoot.typeValue).');

            let params = {
                wsId       : wsMBOM.wsId,
                sections   : wsMBOM.sections,
                getDetails : true,
                fields     : [{
                    fieldId : config.workspaceMBOM.fieldIDs.title,
                    value   : assemblyIndexTitle
                }, {
                    fieldId : config.workspaceMBOM.fieldIDs.type,
                    value   : { link : typeValue }
                }, {
                    fieldId : 'DESCRIPTION',
                    value   : containingTitle
                }, {
                    fieldId : 'GRUPA_PRODUKTOWA',
                    value   : assemblyIndexPLMDefaults.productGroup
                }, {
                    fieldId : 'TYP_CZESCI',
                    value   : assemblyIndexPLMDefaults.partType
                }, {
                    fieldId : 'RODZAJ',
                    value   : assemblyIndexPLMDefaults.kind
                }, {
                    fieldId : 'WARIANT',
                    value   : assemblyIndexPLMDefaults.variant
                }, {
                    fieldId : 'SPECYFIKACJA',
                    value   : assemblyIndexPLMDefaults.specification
                }]
            };

            return $.post({
                url         : '/plm/create',
                contentType : 'application/json',
                data        : JSON.stringify(params)
            }).then(function(response) {
                if(!response || response.error) {
                    throw new Error(response && response.message ? response.message : 'PLM nie utworzył indeksu złożeniowego.');
                }

                let createdLink = response.data && response.data.__self__ ? response.data.__self__ : response.data;
                if(typeof createdLink === 'string') createdLink = createdLink.replace(/^https?:\/\/[^/]+/i, '');
                if(isBlank(createdLink)) throw new Error('Utworzony indeks nie zwrócił prawidłowego linku.');

                let elemRootHeader = $('#mbom-tree').children('.item').first().children('.item-head').first();
                if(elemRootHeader.length === 0) throw new Error('Nie znaleziono głównego elementu MBOM.');

                return insertAdditionalItem(elemRootHeader, createdLink).then(function(elemInserted) {
                    promoteAssemblyIndexToMBOMBranch(elemInserted);
                    return elemInserted;
                });
            });
        }).then(function() {
            updateMBOMNumbers();
        }).catch(function(error) {
            console.warn('MBOM custom: failed to create assembly index', error);
            showErrorMessage('Dodaj indeks montażowy/złożeniowy', String(error && error.message ? error.message : error));
        }).finally(function() {
            $('#overlay').hide();
            elemButton.removeClass('disabled').text('Dodaj indeks złożeniowy');
        });
    }

    function insertAddAssemblyIndexButton() {
        if($('#mbom-add-assembly-index').length > 0) return;

        let elemProcessContainer = $('#mbom-add-process');
        if(elemProcessContainer.length === 0) return;

        elemProcessContainer.css({ display : 'flex', flexWrap : 'wrap' });

        let elemButtonRow = $('<div></div>')
            .attr('id', 'mbom-add-assembly-index-row')
            .css({ display : 'flex', flex : '0 0 100%', width : '100%', marginBottom : '6px' })
            .prependTo(elemProcessContainer);

        $('<div></div>')
            .attr('id', 'mbom-add-assembly-index')
            .addClass('button default')
            .text('Dodaj indeks złożeniowy')
            .click(createAssemblyIndex)
            .appendTo(elemButtonRow);
    }

    function insertSelectedWorkspaceProcess() {
        let selectedItem = getSelectedAddProcessItem();
        if(!selectedItem) {
            showErrorMessage('Add Process', 'Please select a process from workspace ' + addProcessWorkspaceId + '.');
            return false;
        }

        let title = getAddProcessItemTitle(selectedItem);
        if(isBlank(title)) title = $('#mbom-add-name option:selected').text().trim();
        if(isBlank(title)) {
            showErrorMessage('Add Process', 'The selected process does not expose a usable name.');
            return false;
        }

        let processCode = getNextProcessCode();

        let node = {
            level       : 1,
            bomType     : 'mbom',
            title       : title,
            hasChildren : true,
            isEBOMItem  : false,
            isProcess   : true,
            isLeaf      : false,
            icon        : 'radio-process',
            code        : processCode,
            revision    : '-',
            quantity    : 1
        };

        let elemNew = insertBOMPartListNode('mbom', null, node);
        let elemBOM = $('#mbom-tree').children().first().children('.item-bom').first();

        if(elemBOM.length === 0) {
            showErrorMessage('Add Process', 'Could not find the MBOM root target.');
            return false;
        }

        if(disassembleMode) elemBOM.prepend(elemNew);
        else elemBOM.append(elemNew);

        updateMBOMNumbers();
        selectProcess(elemNew);

        $('#mbom-add-name').val('');
        $('#mbom-add-code').val('');
        $('#mbom-add-name').focus();

        return true;
    }

    function getMBOMSaveLink(elemItem) {
        if(!elemItem || elemItem.length === 0) return '';
        return elemItem.attr('data-link-mbom') || elemItem.attr('data-link') || '';
    }

    function getMBOMEditorUrl(linkMBOM) {
        if(isBlank(linkMBOM)) return '';

        let parts = String(linkMBOM).split('/');
        if(parts.length < 7) return '';

        return '/mbom'
            + '?wsId='    + parts[4]
            + '&dmsId='   + parts[6]
            + '&theme='   + theme
            + '&options=' + options;
    }

    function openMBOMEditorFromItem(elemItem) {
        if(!elemItem || elemItem.length === 0) return false;

        let linkMBOM = elemItem.attr('data-mbom') || elemItem.attr('data-link-mbom') || elemItem.attr('data-link');
        let url = getMBOMEditorUrl(linkMBOM);

        if(isBlank(url)) {
            console.warn('MBOM custom: could not build MBOM editor URL', {
                linkMBOM : linkMBOM
            });
            return false;
        }

        console.log('MBOM custom: opening MBOM editor in new tab', {
            linkMBOM : linkMBOM,
            url      : url
        });

        window.open(url, '_blank');
        return true;
    }

    function createExistingChildState() {
        return {
            links    : new Set(),
            children : new Map()
        };
    }

    function addExistingChildToState(state, part) {
        if(!state || !part || isBlank(part.link)) return;

        let normalizedLink = normalizePLMLink(part.link);
        if(isBlank(normalizedLink)) return;

        state.links.add(normalizedLink);
        if(!state.children.has(normalizedLink)) {
            state.children.set(normalizedLink, part);
        }
    }

    function mergeParentEdgeIds(elemHeader, edgeIds) {
        if(!elemHeader || elemHeader.length === 0 || !Array.isArray(edgeIds) || edgeIds.length === 0) return;

        let elemParentItem = elemHeader.closest('.item');
        if(elemParentItem.length === 0) return;

        let existingEdges = [];
        let currentEdges = elemParentItem.attr('data-edges');

        if(!isBlank(currentEdges)) {
            existingEdges = currentEdges.split(',').filter(function(edgeId) {
                return !isBlank(edgeId);
            });
        }

        edgeIds.forEach(function(edgeId) {
            if(isBlank(edgeId)) return;
            if(existingEdges.indexOf(edgeId) < 0) existingEdges.push(edgeId);
        });

        elemParentItem.attr('data-edges', existingEdges.join(','));
    }

    function syncExistingChildStateToDOM(elemHeader, existingState) {
        if(!elemHeader || elemHeader.length === 0 || !existingState || !(existingState.children instanceof Map)) return;

        let edgeIds = [];

        existingState.children.forEach(function(part, normalizedLink) {
            if(part && !isBlank(part.edgeId)) edgeIds.push(part.edgeId);

            let elemExisting = getDirectChildItemByLink(elemHeader, normalizedLink);
            if(elemExisting.length === 0 || !part) return;

            if(isBlank(elemExisting.attr('data-edge')) && !isBlank(part.edgeId)) {
                elemExisting.attr('data-edge', part.edgeId);
            }
            if(isBlank(elemExisting.attr('data-link-db')) && !isBlank(part.link)) {
                elemExisting.attr('data-link-db', part.link);
            }
            if(isBlank(elemExisting.attr('data-number-db')) && !isBlank(part.number)) {
                elemExisting.attr('data-number-db', part.number);
            }
            if(isBlank(elemExisting.attr('data-qty')) && !isBlank(part.quantity)) {
                elemExisting.attr('data-qty', part.quantity);
            }
        });

        mergeParentEdgeIds(elemHeader, edgeIds);
    }

    function fetchExistingBOMChildren(elemHeader) {
        if(!elemHeader || elemHeader.length === 0) return Promise.resolve(createExistingChildState());

        let elemTargetItem = elemHeader.closest('.item');
        let linkParent = getMBOMSaveLink(elemTargetItem);
        if(isBlank(linkParent)) {
            let state = createExistingChildState();
            getDirectChildItemLinks(elemHeader).forEach(function(link) {
                addExistingChildToState(state, { link: link });
            });
            return Promise.resolve(state);
        }

        let params = {
            link            : linkParent,
            viewId          : wsMBOM.viewId,
            depth           : 1,
            revisionBias    : 'working',
            getBOMPartsList : true
        };

        return $.get('/plm/bom', params).then(function(response) {
            let state = createExistingChildState();
            let parts = response && response.data && Array.isArray(response.data.bomPartsList) ? response.data.bomPartsList : [];

            parts.forEach(function(part, index) {
                if(index === 0) return;
                if(part.level === 1 && !isBlank(part.link)) {
                    addExistingChildToState(state, part);
                }
            });

            getDirectChildItemLinks(elemHeader).forEach(function(link) {
                addExistingChildToState(state, { link: link });
            });

            syncExistingChildStateToDOM(elemHeader, state);

            return state;
        }).catch(function(error) {
            console.warn('MBOM custom: failed to fetch existing BOM child links for duplicate check', linkParent, error);
            let state = createExistingChildState();
            getDirectChildItemLinks(elemHeader).forEach(function(link) {
                addExistingChildToState(state, { link: link });
            });
            syncExistingChildStateToDOM(elemHeader, state);
            return state;
        });
    }

    function collectMBOMParentsForSaveSync() {
        let headers = [];

        $('#mbom .item-bom').each(function() {
            let elemBOM = $(this);
            let elemParentItem = elemBOM.parent('.item');
            if(elemParentItem.length === 0) return;
            if(isBlank(getMBOMSaveLink(elemParentItem))) return;
            if(elemBOM.children('.item').length === 0) return;

            let needsSync = false;

            elemBOM.children('.item').each(function() {
                let elemChild = $(this);
                if(isBlank(elemChild.attr('data-edge')) || isBlank(elemChild.attr('data-number-db')) || isBlank(elemChild.attr('data-link-db'))) {
                    needsSync = true;
                    return false;
                }
            });

            if(!needsSync) return;

            let elemHeader = elemParentItem.children('.item-head').first();
            if(elemHeader.length > 0) headers.push(elemHeader);
        });

        return headers;
    }

    function initSaveCheckDialog(total) {
        let count = Number(total) || 0;

        $('.step-bar').addClass('transition-stopper');
        $('.step-bar').css('width', '0%');
        $('#overlay').show();
        $('#confirm-saving').addClass('disabled').removeClass('default');
        $('.in-work').removeClass('in-work');
        $('#step0').addClass('in-work');
        $('.step-bar').removeClass('transition-stopper');

        $('#step-counter0').html('0 of ' + count);
        $('#step-counter1').html('0 of 0');
        $('#step-counter2').html('0 of 0');
        $('#step-counter3').html('0 of 0');
        $('#step-counter4').html('0 of 0');

        $('#dialog-saving').show();
    }

    function updateSaveCheckDialog(current, total) {
        let done = Number(current) || 0;
        let count = Number(total) || 0;
        let progress = count > 0 ? (done * 100 / count) : 100;

        $('#step-bar0').css('width', progress + '%');
        $('#step-counter0').html(done + ' of ' + count);
    }

    function completeSaveCheckDialog(total) {
        let count = Number(total) || 0;
        $('#step-bar0').css('width', '100%');
        $('#step0').removeClass('in-work');
        $('#step-counter0').html(count + ' of ' + count);
    }

    function syncExistingBOMStateBeforeSave() {
        let headers = collectMBOMParentsForSaveSync();

        console.log('MBOM custom: preparing BOM save state sync', {
            parentCount : headers.length
        });

        if(headers.length === 0) return Promise.resolve();

        let chain = Promise.resolve();
        let done = 0;

        headers.forEach(function(elemHeader) {
            chain = chain.then(function() {
                let elemItem = elemHeader.closest('.item');
                let parentLink = getMBOMSaveLink(elemItem);

                console.log('MBOM custom: syncing existing BOM children before save', {
                    parentLink  : parentLink,
                    descriptor  : getERPTechnologyDescriptor(elemItem),
                    childCount  : elemItem.children('.item-bom').children('.item').length
                });

                return fetchExistingBOMChildren(elemHeader).then(function(result) {
                    done++;
                    updateSaveCheckDialog(done, headers.length);
                    return result;
                });
            });
        });

        return chain.then(function() {
            console.log('MBOM custom: BOM save state sync finished', {
                parentCount : headers.length
            });
        });
    }

    function attachCustomSaveGuard() {
        let elemSave = $('#save');
        if(elemSave.length === 0) return;
        if(elemSave.attr('data-custom-save-guard') === 'true') return;

        elemSave.attr('data-custom-save-guard', 'true');
        elemSave.off('click').on('click', function() {
            let elemButton = $(this);
            if(elemButton.hasClass('disabled')) return;

            elemButton.addClass('disabled');
            let headers = collectMBOMParentsForSaveSync();

            initSaveCheckDialog(headers.length);

            syncExistingBOMStateBeforeSave().then(function() {
                completeSaveCheckDialog(headers.length);
                setSaveActions();
                showSaveProcessingDialog();
                createNewItems();
            }).catch(function(error) {
                console.warn('MBOM custom: failed to synchronize existing BOM state before save', error);
                showErrorMessage('Error while preparing save', 'Could not validate existing BOM entries before saving.');
            }).finally(function() {
                elemButton.removeClass('disabled');
            });
        });
    }

    if(typeof showSaveProcessingDialog === 'function') {
        let originalShowSaveProcessingDialog = showSaveProcessingDialog;
        showSaveProcessingDialog = function() {
            let checkFinished = $('#step-counter0').length > 0 && !$('#step0').hasClass('in-work');

            originalShowSaveProcessingDialog.apply(this, arguments);

            if(checkFinished) {
                $('#step-bar0').addClass('transition-stopper').css('width', '100%').removeClass('transition-stopper');
            }
        };
    }

    function ensureExistingRawMaterialRow(elemHeader, existingPart) {
        if(!elemHeader || elemHeader.length === 0 || !existingPart || isBlank(existingPart.link)) return $();

        let elemExisting = getDirectChildItemByLink(elemHeader, existingPart.link);
        if(elemExisting.length > 0) return elemExisting;

        let elemParent = elemHeader.next();
        if(elemParent.length === 0) return $();

        let renderNode = $.extend(true, {}, existingPart);
        prepareMBOMPartForCustomTree(renderNode);
        renderNode.hasChildren = !!renderNode.hasChildren;
        renderNode.isProcess = isMBOMProcess(renderNode);
        renderNode.isLeaf = isMBOMLeaf(renderNode);
        renderNode.icon = getBOMPartIcon(renderNode);

        let elemNode = insertBOMPartListNode('mbom', null, renderNode).appendTo(elemParent);
        elemNode
            .attr('data-edge', renderNode.edgeId || '')
            .attr('data-link-db', renderNode.link || '')
            .attr('data-number-db', renderNode.number || '')
            .attr('data-qty', renderNode.quantity || 0);

        return elemNode;
    }

    function getCustomMBOMDepth() {
        if(typeof config !== 'undefined') {
            if(config.workspaceMBOM && !isBlank(config.workspaceMBOM.depth)) return config.workspaceMBOM.depth;
            if(config.workspaceEBOM && !isBlank(config.workspaceEBOM.depth)) return config.workspaceEBOM.depth;
        }
        return 10;
    }

    function getBOMPartHasChildrenCustom(node, bomPartsList) {
        if(!node || !Array.isArray(bomPartsList) || bomPartsList.length === 0) return false;

        let level = node.level + 1;
        let index = bomPartsList.indexOf(node) + 1;

        while(index > 0 && index < bomPartsList.length) {
            if(bomPartsList[index].level < level) break;

            if(bomPartsList[index].level === level) {
                let ignoreChild = isBlank(bomPartsList[index].ignoreInMBOM) ? false : bomPartsList[index].ignoreInMBOM;
                if(!ignoreChild) return true;
            }

            index++;
        }

        return false;
    }

    function isAssemblyIndexNode(node) {
        if(!node || Number(node.level) === 0) return false;
        if(node.isAssemblyIndex) return true;

        let title = String(node.title || '').trim().toLowerCase();
        return title.indexOf('indeks złożeniowy ') === 0 ||
            title.indexOf('indeks zlozeniowy ') === 0;
    }

    function getBOMLinkedFieldLink(value) {
        if(isBlank(value)) return '';
        if(typeof value === 'string') {
            return value.indexOf('/api/v3/workspaces/') >= 0
                ? value.replace(/^https?:\/\/[^/]+/i, '')
                : '';
        }
        if(typeof value !== 'object') return '';

        if(!isBlank(value.link)) return String(value.link).replace(/^https?:\/\/[^/]+/i, '');
        if(!isBlank(value.__self__)) return String(value.__self__).replace(/^https?:\/\/[^/]+/i, '');
        if(value.value) return getBOMLinkedFieldLink(value.value);

        return '';
    }

    function resolveMBOMEBOMRootLink(mbomPart) {
        if(!mbomPart) return '';

        let fieldId = config.workspaceMBOM.fieldIDs.ebomRoot;
        let fieldLink = getBOMLinkedFieldLink(getBOMPartFieldValue(mbomPart, fieldId));
        let linkedEBOM = getBOMLinkedFieldLink(mbomPart.ebom);

        if(Array.isArray(ebomPartsList)) {
            let normalizedFieldLink = normalizePLMLink(fieldLink);
            let normalizedLinkedEBOM = normalizePLMLink(linkedEBOM);

            for(let ebomPart of ebomPartsList) {
                let normalizedRoot = normalizePLMLink(ebomPart.root);
                let normalizedLink = normalizePLMLink(ebomPart.link);

                if((!isBlank(normalizedFieldLink) &&
                        (normalizedFieldLink === normalizedRoot || normalizedFieldLink === normalizedLink)) ||
                    (!isBlank(normalizedLinkedEBOM) &&
                        (normalizedLinkedEBOM === normalizedRoot || normalizedLinkedEBOM === normalizedLink))) {
                    return ebomPart.root || fieldLink || linkedEBOM;
                }
            }
        }

        return fieldLink || linkedEBOM;
    }

    function getBOMBooleanValue(value) {
        if(value === true || value === 1) return true;
        if(value === false || value === 0 || value === null || typeof value === 'undefined') return false;
        if(typeof value === 'string') return ['true', '1', 'yes', 'y'].includes(value.trim().toLowerCase());
        if(typeof value === 'object') {
            if(typeof value.value !== 'undefined') return getBOMBooleanValue(value.value);
            if(typeof value.title !== 'undefined') return getBOMBooleanValue(value.title);
        }
        return false;
    }

    function prepareMBOMPartForCustomTree(mbomPart) {
        if(!mbomPart) return;

        mbomPart.bomType  = 'mbom';
        mbomPart.ebom     = getBOMPartFieldValue(mbomPart, config.workspaceMBOM.fieldIDs.ebom);
        mbomPart.type     = mbomPart.details[config.workspaceMBOM.fieldIDs.type] || '';
        mbomPart.category = mbomPart.details[config.workspaceMBOM.fieldIDs.category] || '';
        mbomPart.code     = mbomPart.details[config.workspaceMBOM.fieldIDs.code] || '';
        mbomPart.ebomRoot = resolveMBOMEBOMRootLink(mbomPart);
        mbomPart.unitOfMeasure = getMBOMPartUnitOfMeasure(mbomPart);
        mbomPart.isAssemblyIndex = isAssemblyIndexNode(mbomPart);

        getMatchingEBOMPartProperties(mbomPart);

        mbomPart.isEBOMItem = getBOMBooleanValue(getBOMPartFieldValue(mbomPart, config.workspaceMBOM.bomFieldIDs.isEBOMItem));
        mbomPart.makeBuy    = getBOMPartFieldValue(mbomPart, config.workspaceMBOM.bomFieldIDs.makeOrBuy);

        if(mbomPart.revision === 'WIP') mbomPart.revision = 'W';
    }

    function refreshMBOMHierarchyFlags() {
        if(!Array.isArray(mbomPartsList)) return;

        mbomPartsList.forEach(function(mbomPart) {
            prepareMBOMPartForCustomTree(mbomPart);
            mbomPart.hasChildren = getBOMPartHasChildrenCustom(mbomPart, mbomPartsList);
            mbomPart.isProcess = isMBOMProcess(mbomPart);
            if(mbomPart.isProcess) mbomPart.hasChildren = true;
            if(mbomPart.isAssemblyIndex) mbomPart.hasChildren = true;
            mbomPart.isLeaf = isMBOMLeaf(mbomPart);
            mbomPart.icon = getBOMPartIcon(mbomPart);
        });
    }

    function fetchInlineSubMBOMChildren(part, linkOverride, isAssemblyIndex) {
        let primaryLink = linkOverride || part.link;
        let linksToTry = [];

        function addLinkCandidate(link) {
            if(isBlank(link) || linksToTry.indexOf(link) >= 0) return;
            linksToTry.push(link);
        }

        // Preserve the link that worked before as the primary request. An
        // assembly-index edge can point at an older version, so retry the
        // item-level working BOM only when the primary BOM has no children.
        addLinkCandidate(primaryLink);
        if(isAssemblyIndex || (part && part.isAssemblyIndex)) {
            addLinkCandidate(part ? part.link : '');
            addLinkCandidate(getPLMItemLevelLink(primaryLink));
            addLinkCandidate(getPLMItemLevelLink(part ? part.link : ''));
        }

        function fetchCandidate(candidateIndex, previousError) {
            if(candidateIndex >= linksToTry.length) {
                if(previousError) throw previousError;
                return [];
            }

            let params = {
                link            : linksToTry[candidateIndex],
                viewId          : wsMBOM.viewId,
                depth           : getCustomMBOMDepth(),
                revisionBias    : 'working',
                getBOMPartsList : true
            };

            return $.get('/plm/bom', params).then(function(response) {
                let parts = response && response.data && Array.isArray(response.data.bomPartsList) ? response.data.bomPartsList : [];
                console.info('MBOM custom: inline sub-MBOM fetch result', {
                    link       : params.link,
                    attempt    : candidateIndex + 1,
                    partsCount : parts.length,
                    root       : response && response.data ? response.data.root : null
                });

                if(parts.length <= 1) {
                    return fetchCandidate(candidateIndex + 1, previousError);
                }

                let children = parts.slice(1).map(function(childPart) {
                    let childClone = $.extend(true, {}, childPart);
                    childClone.level = part.level + childPart.level;
                    childClone.__customInlineInjected = true;
                    prepareMBOMPartForCustomTree(childClone);
                    return childClone;
                });

                console.info('MBOM custom: expanded inline sub-MBOM for', params.link, 'with', children.length, 'child item(s).');
                return children;
            }, function(error) {
                console.warn('MBOM custom: failed inline sub-MBOM link candidate', params.link, error);
                return fetchCandidate(candidateIndex + 1, error);
            });
        }

        return fetchCandidate(0, null);
    }

    function getMBOMPartFromElement(elemItem) {
        if(!elemItem || elemItem.length === 0 || !Array.isArray(mbomPartsList)) return null;

        let link = elemItem.attr('data-link');
        let root = elemItem.attr('data-root');

        return mbomPartsList.find(function(part) {
            return part.link === link && part.root === root;
        }) || null;
    }

    function getInlineSubMBOMLink(elemItem, part) {
        if(elemItem && elemItem.length > 0) {
            let link = elemItem.attr('data-mbom') || elemItem.attr('data-link-mbom') || elemItem.attr('data-link');
            if(!isBlank(link)) return link;
        }
        return part ? part.link : '';
    }

    function getElementLevel(elemItem) {
        if(!elemItem || elemItem.length === 0) return 0;

        let classNames = (elemItem.attr('class') || '').split(/\s+/);
        for(let className of classNames) {
            if(className.indexOf('level-') === 0) {
                let level = parseInt(className.replace('level-', ''), 10);
                if(!Number.isNaN(level)) return level;
            }
        }

        return 0;
    }

    function resolveInlineSubMBOMContext(elemItem) {
        let part = getMBOMPartFromElement(elemItem);
        let ebomLink = '';

        if(part && part.ebom && part.ebom.link) {
            ebomLink = part.ebom.link;
        } else if(elemItem && elemItem.length > 0) {
            ebomLink = elemItem.attr('data-ebom') || '';
        }

        if(!isBlank(ebomLink)) {
            return $.get('/plm/details', { link: ebomLink }).then(function(response) {
                let expansionLink = getSectionFieldValue(response.data.sections, config.workspaceEBOM.fieldIDs.mbom, '', 'link');
                let fallbackPart = part || {
                    link  : elemItem.attr('data-link'),
                    root  : elemItem.attr('data-root'),
                    level : getElementLevel(elemItem)
                };

                return {
                    part          : fallbackPart,
                    expansionLink : expansionLink || getInlineSubMBOMLink(elemItem, fallbackPart)
                };
            }).catch(function(error) {
                console.warn('MBOM custom: failed to resolve linked MBOM from EBOM item', ebomLink, error);
                return {
                    part : part || {
                        link  : elemItem.attr('data-link'),
                        root  : elemItem.attr('data-root'),
                        level : getElementLevel(elemItem)
                    },
                    expansionLink : getInlineSubMBOMLink(elemItem, part)
                };
            });
        }

        if(part) {
            return Promise.resolve({
                part          : part,
                expansionLink : getInlineSubMBOMLink(elemItem, part)
            });
        }

        return Promise.resolve({
            part : {
                link  : elemItem ? elemItem.attr('data-link') : '',
                root  : elemItem ? elemItem.attr('data-root') : '',
                level : getElementLevel(elemItem)
            },
            expansionLink : getInlineSubMBOMLink(elemItem, null)
        });
    }

    function ensureInlineSubMBOMContainer(elemItem) {
        let elemBOM = elemItem.children('.item-bom').first();
        if(elemBOM.length === 0) {
            elemBOM = $('<div></div>').appendTo(elemItem)
                .addClass('item-bom')
                .addClass('no-scrollbar');
        }

        elemItem.removeClass('leaf').addClass('item-has-bom');

        let elemToggle = elemItem.children('.item-head').children('.item-toggle').first();
        let hasShortcutIcons = elemToggle.children('.mbom-shortcut.icon-factory').length > 0;
        if(elemToggle.length > 0 && !hasShortcutIcons && !elemToggle.hasClass('icon-collapse') && !elemToggle.hasClass('icon-expand')) {
            addBOMToggle(elemToggle);
        }

        return elemBOM;
    }

    function setInlineSubMBOMStatus(elemItem, message, isError) {
        let elemBOM = ensureInlineSubMBOMContainer(elemItem);
        let elemStatus = elemBOM.children('.inline-submbom-status').first();

        if(elemStatus.length === 0) {
            elemStatus = $('<div></div>').prependTo(elemBOM)
                .addClass('inline-submbom-status');
        }

        elemStatus
            .toggleClass('error', !!isError)
            .text(message);

        return elemStatus;
    }

    function renderInlineSubMBOMBranch(elemParent, parts, startIndex) {
        if(startIndex < 0 || startIndex >= parts.length) return null;

        let node = parts[startIndex];
        let renderNode = $.extend(true, {}, node, {
            hasChildren : false,
            isLeaf      : true
        });
        let elemNode = insertBOMPartListNode('mbom', null, renderNode).appendTo(elemParent);

        if(!node.hasChildren) return elemNode;

        let elemNodeBOM = ensureInlineSubMBOMContainer(elemNode);
        let nextLevel = node.level + 1;
        let nextIndex = startIndex + 1;

        while(nextIndex < parts.length) {
            if(parts[nextIndex].level < nextLevel) break;

            if(parts[nextIndex].level === nextLevel) {
                renderInlineSubMBOMBranch(elemNodeBOM, parts, nextIndex);
            }

            nextIndex++;
        }

        return elemNode;
    }

    function appendInlineSubMBOMChildren(elemItem, children) {
        let elemBOM = ensureInlineSubMBOMContainer(elemItem);
        elemBOM.children('.inline-submbom-status').remove();
        elemBOM.removeClass('hidden');

        children.forEach(function(childPart) {
            childPart.hasChildren = getBOMPartHasChildrenCustom(childPart, children);
            childPart.isProcess = isMBOMProcess(childPart);
            if(childPart.isProcess) childPart.hasChildren = true;
            childPart.isLeaf = isMBOMLeaf(childPart);
            childPart.icon = getBOMPartIcon(childPart);
        });

        let index = 0;
        while(index < children.length) {
            if(children[index].level === children[0].level) {
                renderInlineSubMBOMBranch(elemBOM, children, index);
            }
            index++;
        }

        updateMBOMNumbers();
    }

    function toggleInlineSubMBOM(elemItem) {
        let elemToggle = elemItem.children('.item-head').children('.item-toggle').first();
        let elemBOM = elemItem.children('.item-bom').first();

        if(elemToggle.hasClass('icon-collapse') || elemToggle.hasClass('icon-expand')) {
            elemToggle.toggleClass('icon-collapse').toggleClass('icon-expand');
        }

        elemBOM.toggleClass('hidden');
    }

    function ensureInlineSubMBOMExpanded(elemItem) {
        if(!elemItem || elemItem.length === 0) return Promise.resolve(false);

        if(elemItem.attr('data-inline-submbom-loaded') === 'true') {
            let elemBOM = ensureInlineSubMBOMContainer(elemItem);
            elemBOM.removeClass('hidden');

            let elemToggle = elemItem.children('.item-head').children('.item-toggle').first();
            if(elemToggle.hasClass('icon-expand')) {
                elemToggle.removeClass('icon-expand').addClass('icon-collapse');
            }

            return Promise.resolve(true);
        }

        if(elemItem.attr('data-inline-submbom-loaded') === 'loading') {
            return Promise.resolve(false);
        }

        // An empty result may become stale when the linked MBOM is edited in
        // another tab. Always retry it instead of caching "empty" forever.
        elemItem.attr('data-inline-submbom-loaded', 'loading');
        setInlineSubMBOMStatus(elemItem, 'Loading sub-MBOM...', false);
        $('#overlay').show();

        return resolveInlineSubMBOMContext(elemItem).then(function(context) {
            let part = context.part;
            let expansionLink = context.expansionLink;

            if(!part || isBlank(part.link)) {
                console.warn('MBOM custom: could not resolve MBOM part for inline expansion', elemItem.attr('data-link'));
                elemItem.removeAttr('data-inline-submbom-loaded');
                setInlineSubMBOMStatus(elemItem, 'Could not resolve MBOM part for inline expansion.', true);
                $('#overlay').hide();
                return false;
            }

            if(isBlank(expansionLink)) {
                console.warn('MBOM custom: no MBOM link available for inline expansion', elemItem.attr('data-link'));
                elemItem.removeAttr('data-inline-submbom-loaded');
                setInlineSubMBOMStatus(elemItem, 'No MBOM link available for inline expansion.', true);
                $('#overlay').hide();
                return false;
            }

            console.info('MBOM custom: starting inline sub-MBOM expansion', {
                clickedItemLink : elemItem.attr('data-link'),
                expansionLink   : expansionLink,
                root            : elemItem.attr('data-root'),
                level           : part.level
            });

            return fetchInlineSubMBOMChildren(part, expansionLink, elemItem.hasClass('assembly-index')).then(function(children) {
                $('#overlay').hide();

                if(children.length === 0) {
                    console.info('MBOM custom: no inline sub-MBOM children found for', expansionLink);
                    elemItem.attr('data-inline-submbom-loaded', 'empty');
                    setInlineSubMBOMStatus(elemItem, 'No sub-MBOM children were returned for this item.', true);
                    return false;
                }

                console.info('MBOM custom: rendering inline sub-MBOM children', {
                    expansionLink : expansionLink,
                    childCount    : children.length,
                    firstLevel    : children[0].level
                });

                appendInlineSubMBOMChildren(elemItem, children);
                elemItem.attr('data-inline-submbom-loaded', 'true');
                return true;
            });
        }).catch(function(error) {
            $('#overlay').hide();
            elemItem.removeAttr('data-inline-submbom-loaded');
            console.warn('MBOM custom: inline sub-MBOM expansion failed', error);
            setInlineSubMBOMStatus(elemItem, 'Sub-MBOM expansion failed. Check browser console.', true);
            return false;
        });
    }

    function expandInlineSubMBOMForElement(elemItem) {
        if(!elemItem || elemItem.length === 0) return;

        if(elemItem.attr('data-inline-submbom-loaded') === 'true') {
            console.info('MBOM custom: toggling already loaded inline sub-MBOM for', elemItem.attr('data-link'));
            toggleInlineSubMBOM(elemItem);
            return;
        }

        ensureInlineSubMBOMExpanded(elemItem);
    }

    function ensureMBOMBranchReadyForRawMaterial(part) {
        let elemMBOMItem = getMBOMItemForEBOMPart(part);
        if(!elemMBOMItem || elemMBOMItem.length === 0) {
            console.warn('MBOM custom: could not prepare MBOM branch because no linked MBOM item was found', {
                ebomLink   : getPartItemLink(part),
                material   : getMaterialValue(part),
                partNumber : getPartNumber(part)
            });
            return Promise.resolve($());
        }

        let hasDirectProcessChild = getFirstDirectProcessChildHeader(elemMBOMItem).length > 0;
        if(hasDirectProcessChild) {
            console.log('MBOM custom: linked MBOM item already has a direct process child in DOM', {
                ebomLink   : getPartItemLink(part),
                targetItem : describeMBOMItem(elemMBOMItem)
            });
            return Promise.resolve(elemMBOMItem);
        }

        if(elemMBOMItem.hasClass('process') && !hasMBOMShortcut(elemMBOMItem)) {
            console.log('MBOM custom: linked MBOM item is a process node without child process nodes, no expansion needed', {
                ebomLink   : getPartItemLink(part),
                targetItem : describeMBOMItem(elemMBOMItem)
            });
            return Promise.resolve(elemMBOMItem);
        }

        if(!hasMBOMShortcut(elemMBOMItem)) {
            console.log('MBOM custom: linked MBOM item has no inline sub-MBOM shortcut, using current node as-is', {
                ebomLink   : getPartItemLink(part),
                targetItem : describeMBOMItem(elemMBOMItem)
            });
            return Promise.resolve(elemMBOMItem);
        }

        console.log('MBOM custom: expanding linked MBOM item to find direct process child target', {
            ebomLink   : getPartItemLink(part),
            targetItem : describeMBOMItem(elemMBOMItem)
        });

        return ensureInlineSubMBOMExpanded(elemMBOMItem).then(function() {
            console.log('MBOM custom: linked MBOM item expansion finished', {
                ebomLink         : getPartItemLink(part),
                targetItem       : describeMBOMItem(elemMBOMItem),
                processChildFound: getFirstDirectProcessChildHeader(elemMBOMItem).length > 0
            });
            return elemMBOMItem;
        });
    }

    function resolveEBOMMaterials(ebomPartsList) {
        return new Promise(function(resolve) {
            let ebomMaterials = ebomPartsList.map(function(part) {
                return {
                    part       : part,
                    material   : getMaterialValue(part),
                    itemWeight : getItemWeightValue(part)
                };
            });

            let missingFallbackParts = ebomMaterials.filter(function(entry) {
                return isBlank(entry.material) || Number.isNaN(entry.itemWeight) || entry.itemWeight <= 0;
            });

            console.log('MBOM custom: resolved initial EBOM raw material candidates', ebomMaterials.map(function(entry) {
                return {
                    ebomLink    : getPartItemLink(entry.part),
                    partNumber  : getPartNumber(entry.part),
                    material    : entry.material,
                    itemWeight  : entry.itemWeight
                };
            }));

            if(missingFallbackParts.length === 0) {
                resolve(ebomMaterials.filter(function(entry) { return !isBlank(entry.material); }));
                return;
            }

            fetchEBOMPartMaterialsFromDetails(missingFallbackParts.map(function(entry) { return entry.part; }))
                .then(function(results) {
                    let fallbackMap = new Map();
                    results.forEach(function(result) {
                        let link = getPartItemLink(result.part);
                        if(isBlank(link)) return;

                        fallbackMap.set(link, {
                            material   : result.material,
                            itemWeight : result.itemWeight
                        });
                    });

                    ebomMaterials.forEach(function(entry) {
                        let link = getPartItemLink(entry.part);
                        let fallback = fallbackMap.get(link);
                        if(!fallback) return;

                        if(isBlank(entry.material) && !isBlank(fallback.material)) {
                            entry.material = fallback.material;
                        }

                        if((Number.isNaN(entry.itemWeight) || entry.itemWeight <= 0) && !Number.isNaN(fallback.itemWeight) && fallback.itemWeight > 0) {
                            entry.itemWeight = fallback.itemWeight;
                        }
                    });

                    console.log('MBOM custom: resolved final EBOM raw material candidates after fallback', ebomMaterials.map(function(entry) {
                        return {
                            ebomLink    : getPartItemLink(entry.part),
                            partNumber  : getPartNumber(entry.part),
                            material    : entry.material,
                            itemWeight  : entry.itemWeight
                        };
                    }));

                    resolve(ebomMaterials.filter(function(entry) { return !isBlank(entry.material); }));
                })
                .catch(function() {
                    resolve(ebomMaterials.filter(function(entry) { return !isBlank(entry.material); }));
                });
        });
    }

    function initRawMaterialsDialog(searchTotal, applyTotal) {
        let totalSearch = Number(searchTotal) || 0;
        let totalApply = Number(applyTotal) || 0;

        $('#raw-step-bar1, #raw-step-bar2').addClass('transition-stopper');
        $('#raw-step-bar1, #raw-step-bar2').css('width', '0%');
        $('#overlay').show();
        $('#confirm-raw-materials').addClass('disabled').removeClass('default');
        $('#dialog-raw-materials .in-work').removeClass('in-work');
        $('#raw-step1').addClass('in-work');
        $('#raw-step-bar1, #raw-step-bar2').removeClass('transition-stopper');

        $('#raw-step-counter1').html('0 of ' + totalSearch);
        $('#raw-step-counter2').html('0 of ' + totalApply);
        $('#dialog-raw-materials').show();
    }

    function setRawMaterialsDialogPendingState() {
        $('#raw-step-counter1').html('Preparing...');
        $('#raw-step-counter2').html('Waiting...');
    }

    function setRawMaterialsDialogTotals(searchTotal, applyTotal) {
        let totalSearch = Number(searchTotal) || 0;
        let totalApply = Number(applyTotal) || 0;

        $('#raw-step-counter1').html('0 of ' + totalSearch);
        $('#raw-step-counter2').html('0 of ' + totalApply);
    }

    function updateRawMaterialsSearchDialog(current, total) {
        let done = Number(current) || 0;
        let count = Number(total) || 0;
        let progress = count > 0 ? (done * 100 / count) : 100;

        $('#raw-step-bar1').css('width', progress + '%');
        $('#raw-step-counter1').html(done + ' of ' + count);
    }

    function completeRawMaterialsSearchDialog(total) {
        let count = Number(total) || 0;
        $('#raw-step-bar1').css('width', '100%');
        $('#raw-step-counter1').html(count + ' of ' + count);
        $('#raw-step1').removeClass('in-work');
        $('#raw-step2').addClass('in-work');
    }

    function updateRawMaterialsApplyDialog(current, total) {
        let done = Number(current) || 0;
        let count = Number(total) || 0;
        let progress = count > 0 ? (done * 100 / count) : 100;

        $('#raw-step-bar2').css('width', progress + '%');
        $('#raw-step-counter2').html(done + ' of ' + count);
    }

    function completeRawMaterialsDialog(total) {
        let count = Number(total) || 0;
        $('#raw-step-bar2').css('width', '100%');
        $('#raw-step-counter2').html(count + ' of ' + count);
        $('#raw-step2').removeClass('in-work');
        $('#confirm-raw-materials').removeClass('disabled').addClass('default');
    }

    function addRawMaterialsToMBOM(ebomMaterials) {
        if(!Array.isArray(ebomMaterials) || ebomMaterials.length === 0) {
            console.info('MBOM custom: no EBOM parts with MATERIAL values available to add raw materials.');
            $('#confirm-raw-materials').removeClass('disabled').addClass('default');
            return;
        }

        console.log('MBOM custom: Found', ebomMaterials.length, 'EBOM part(s) with MATERIAL values.');

        let button = $('#add-raw-materials');
        if(button.length) {
            button.addClass('disabled');
            button.html('Searching...');
        }

        let uniqueMaterials = Array.from(new Set(ebomMaterials.map(function(entry) { return entry.material; })));
        let searchResultsByMaterial = {};
        let searchDone = 0;
        let applyDone = 0;

        setRawMaterialsDialogTotals(uniqueMaterials.length, ebomMaterials.length);

        let searchRequests = uniqueMaterials.map(function(material) {
            return searchRawMaterialItems(material).then(function(result) {
                searchResultsByMaterial[material] = result;
                searchDone++;
                updateRawMaterialsSearchDialog(searchDone, uniqueMaterials.length);
                return result;
            });
        });

        Promise.all(searchRequests).then(function() {
            completeRawMaterialsSearchDialog(uniqueMaterials.length);
            let totalAdded = 0;
            let totalUpdated = 0;
            let insertedByTarget = {};
            let chain = Promise.resolve();

            ebomMaterials.forEach(function(entry) {
                chain = chain.then(function() {
                    let material = entry.material;

                    let result = searchResultsByMaterial[material];
                    if(!result || !Array.isArray(result.items) || result.items.length === 0) {
                        console.warn('MBOM custom: no matching WS57 TITLE found for MATERIAL', {
                            material : material
                        });
                        applyDone++;
                        updateRawMaterialsApplyDialog(applyDone, ebomMaterials.length);
                        return null;
                    }

                    let item = chooseRawMaterialItem(material, result.items);
                    if(!item) {
                        console.warn('MBOM custom: TITLE match selection failed for MATERIAL', {
                            material : material
                        });
                        applyDone++;
                        updateRawMaterialsApplyDialog(applyDone, ebomMaterials.length);
                        return null;
                    }

                    let link = getSearchItemLink(item);
                    if(isBlank(link)) {
                        console.warn('MBOM custom: raw material match has no usable link', {
                            material : material
                        });
                        applyDone++;
                        updateRawMaterialsApplyDialog(applyDone, ebomMaterials.length);
                        return null;
                    }

                    return getRawMaterialInsertQuantity(entry, item).then(function(quantity) {
                        return ensureMBOMBranchReadyForRawMaterial(entry.part).then(function() {
                            let elemHeader = getRawMaterialTargetHeader(entry.part);
                            if(elemHeader.length === 0) {
                                console.warn('MBOM custom: cannot find MBOM insertion target', {
                                    material : material,
                                    ebomLink  : getPartItemLink(entry.part)
                                });
                                applyDone++;
                                updateRawMaterialsApplyDialog(applyDone, ebomMaterials.length);
                                return null;
                            }

                            let targetKey = getRawMaterialTargetKey(elemHeader);
                            console.log('MBOM custom: inserting new raw material into MBOM', {
                                material : material,
                                targetKey: targetKey,
                                link     : link,
                                quantity : quantity
                            });

                            let targetStatePromise = insertedByTarget[targetKey]
                                ? Promise.resolve(insertedByTarget[targetKey])
                                : fetchExistingBOMChildren(elemHeader).then(function(existingState) {
                                    insertedByTarget[targetKey] = existingState;
                                    return existingState;
                                });

                            return targetStatePromise.then(function(existingState) {
                                let normalizedLink = normalizePLMLink(link);

                                console.log('MBOM custom: resolved raw material target', {
                                    material : material,
                                    targetKey: targetKey,
                                    link     : link,
                                    quantity : quantity
                                });

                                if(existingState.links.has(normalizedLink)) {
                                    console.log('MBOM custom: raw material precheck found existing target assignment', {
                                        material : material,
                                        link     : link,
                                        targetKey: targetKey
                                    });

                                    let elemExisting = getDirectChildItemByLink(elemHeader, link);
                                    if(elemExisting.length === 0) {
                                        let existingPart = existingState.children.get(normalizedLink);
                                        elemExisting = ensureExistingRawMaterialRow(elemHeader, existingPart);
                                    }

                                    if(elemExisting.length > 0 && setRawMaterialQuantity(elemHeader, link, quantity)) {
                                        totalUpdated++;
                                        console.log('MBOM custom: raw material already exists, quantity set to resolved value', {
                                            material : material,
                                            link     : link,
                                            targetKey: targetKey,
                                            quantity : quantity
                                        });
                                    } else {
                                        console.warn('MBOM custom: raw material exists but DOM row could not be updated', {
                                            material : material,
                                            link     : link,
                                            targetKey: targetKey
                                        });
                                    }
                                    applyDone++;
                                    updateRawMaterialsApplyDialog(applyDone, ebomMaterials.length);
                                    return null;
                                }

                                console.log('MBOM custom: inserting new raw material into MBOM', {
                                    material : material,
                                    link     : link,
                                    targetKey: targetKey,
                                    quantity : quantity
                                });

                                return insertAdditionalItem(elemHeader, link).then(function(elemInserted) {
                                    if(!elemInserted || elemInserted.length === 0) {
                                        throw new Error('Raw material item could not be inserted into the MBOM tree.');
                                    }

                                    existingState.links.add(normalizedLink);
                                    existingState.children.set(normalizedLink, { link : link, quantity : quantity });
                                    totalAdded++;

                                    return waitForDirectChildItem(elemHeader, link).then(function(elemInserted) {
                                        if(elemInserted.length === 0) {
                                            console.warn('MBOM custom: inserted raw material row was not found in DOM after insert', {
                                                material : material,
                                                link     : link,
                                                targetKey: targetKey
                                            });
                                            return null;
                                        }

                                        if(!setRawMaterialQuantity(elemHeader, link, quantity)) {
                                            console.warn('MBOM custom: inserted raw material quantity could not be set', {
                                                material : material,
                                                link     : link,
                                                quantity : quantity,
                                                targetKey: targetKey
                                            });
                                        }

                                        return null;
                                    });
                                }).then(function() {
                                    applyDone++;
                                    updateRawMaterialsApplyDialog(applyDone, ebomMaterials.length);
                                    console.log('MBOM custom: raw material insert completed', {
                                        material : material,
                                        link     : link,
                                        targetKey: targetKey
                                    });
                                });
                            });
                        });
                    });
                });
            });

            return chain.then(function() {
                console.log('MBOM custom: Add Raw Materials finished', {
                    added   : totalAdded,
                    updated : totalUpdated,
                    total   : ebomMaterials.length
                });

                if(totalAdded === 0 && totalUpdated === 0) {
                    console.info('MBOM custom: no raw materials were added or updated. Check MATERIAL values and matching TITLE values in WS 57.');
                }

                completeRawMaterialsDialog(ebomMaterials.length);

                if(button.length) {
                    button.removeClass('disabled');
                    button.html('Dodaj Surowce');
                }
            });
        }).catch(function(error) {
            console.warn('MBOM custom: raw material search failed', error);
            completeRawMaterialsDialog(applyDone);
            if(button.length) {
                button.removeClass('disabled');
                button.html('Dodaj Surowce');
            }
        });
    }

    function getUniqueMaterialsFromEBOMParts(ebomPartsList) {
        let materials = new Set();

        for(let part of ebomPartsList) {
            let material = getMaterialValue(part);
            if(!isBlank(material)) {
                materials.add(material);
            }
        }

        return Array.from(materials);
    }

    function findTitleMatchesForMaterials() {
        console.log('MBOM custom: Finding MATERIAL matches on init');

        if(Array.isArray(ebomPartsList) && ebomPartsList.length > 0) {
            console.log('MBOM custom: Found loaded ebomPartsList on init with', ebomPartsList.length, 'parts');
            logEBOMMaterials(ebomPartsList);
            return;
        }

        console.warn('MBOM custom: ebomPartsList not available on init; skipping MATERIAL match search');
    }

    function addRawMaterialsFromEBOM() {
        console.log('MBOM custom: Add Raw Materials button clicked');
        initRawMaterialsDialog(0, 0);
        setRawMaterialsDialogPendingState();

        if(Array.isArray(ebomPartsList) && ebomPartsList.length > 0) {
            console.log('MBOM custom: Using loaded ebomPartsList with', ebomPartsList.length, 'items');
            logEBOMMaterials(ebomPartsList);
            resolveEBOMMaterials(ebomPartsList).then(function(ebomMaterials) {
                addRawMaterialsToMBOM(ebomMaterials);
            }).catch(function(error) {
                console.warn('MBOM custom: failed while resolving EBOM materials', error);
                $('#confirm-raw-materials').removeClass('disabled').addClass('default');
            });
            return;
        }

        console.warn('MBOM custom: ebomPartsList not loaded yet; falling back to explicit EBOM fetch');

        let startLink = (typeof urlParameters !== 'undefined' && urlParameters.link) ? urlParameters.link : null;
        if (!startLink) {
            console.warn('MBOM custom: No start link found in URL parameters');

            return;
        }

        console.log('MBOM custom: Fetching details for start link:', startLink);

        $.get('/plm/details', { link: startLink })
            .done(function(detailsResponse) {
                let fieldIdEBOM = (typeof config !== 'undefined' && config.workspaceMBOM && config.workspaceMBOM.fieldIDs && config.workspaceMBOM.fieldIDs.ebom) ? config.workspaceMBOM.fieldIDs.ebom : null;
                if (!fieldIdEBOM) {
                    console.warn('MBOM custom: EBOM field ID not found in config');
                    return;
                }

                let ebomLink = getSectionFieldValue(detailsResponse.data.sections, fieldIdEBOM, '', 'link');
                if (!ebomLink) {
                    console.warn('MBOM custom: No EBOM link found in MBOM item details');
                    return;
                }

                console.log('MBOM custom: Found EBOM link:', ebomLink);

                let ebomWsId = (typeof config !== 'undefined' && config.workspaceEBOM && config.workspaceEBOM.workspaceId) || (typeof common !== 'undefined' && common.workspaceIds && common.workspaceIds.items) || 57;

                $.get('/plm/bom-views', { wsId: ebomWsId })
                    .done(function(viewsResponse) {
                        let bomViewName = (typeof config !== 'undefined' && config.workspaceEBOM && config.workspaceEBOM.bomView) ? config.workspaceEBOM.bomView : 'MBOM Transition';
                        let view = viewsResponse.data.bomViews.find(v => v.name === bomViewName);
                        if (!view) {
                            console.warn('MBOM custom: BOM view not found:', bomViewName);
                            return;
                        }
                        let viewId = view.id;
                        console.log('MBOM custom: Found view ID:', viewId, 'for', bomViewName);

                        let params = {
                            link: ebomLink,
                            viewId: viewId,
                            depth: (typeof config !== 'undefined' && config.workspaceEBOM && config.workspaceEBOM.depth) ? config.workspaceEBOM.depth : 10,
                            revisionBias: 'mostRecent',
                            getBOMPartsList: true
                        };

                        console.log('MBOM custom: Fetching EBOM data with params:', params);

                        $.get('/plm/bom', params)
                            .done(function(bomResponse) {
                                let ebomPartsList = (bomResponse.data && bomResponse.data.bomPartsList) ? bomResponse.data.bomPartsList : [];
                                if (!Array.isArray(ebomPartsList) || ebomPartsList.length === 0) {
                                    console.warn('MBOM custom: No EBOM parts found');
                                    return;
                                }

                                console.log('MBOM custom: Found', ebomPartsList.length, 'EBOM parts');

                                logEBOMMaterials(ebomPartsList);
                                resolveEBOMMaterials(ebomPartsList).then(function(ebomMaterials) {
                                    addRawMaterialsToMBOM(ebomMaterials);
                                }).catch(function(error) {
                                    console.warn('MBOM custom: failed while resolving fetched EBOM materials', error);
                                    $('#confirm-raw-materials').removeClass('disabled').addClass('default');
                                });
                            })
                            .fail(function() {
                                console.warn('MBOM custom: Failed to fetch EBOM data');
                                $('#confirm-raw-materials').removeClass('disabled').addClass('default');
                            });
                    })
                    .fail(function() {
                        console.warn('MBOM custom: Failed to fetch BOM views');
                        $('#confirm-raw-materials').removeClass('disabled').addClass('default');
                    });
            })
            .fail(function() {
                console.warn('MBOM custom: Failed to fetch details for start link');
                $('#confirm-raw-materials').removeClass('disabled').addClass('default');
            });
    }

    function escapeERPStatusHtml(value) {
        return $('<div></div>').text(value || '').html();
    }

    const erpTechnologyProxyBaseUrl = '/plm/custom-erp/';
    const erpTechnologyPropertyMappings = [
        ['Grupa Produktowa', ['GRUPA_PRODUKTOWA']],
        ['Typ czesci', ['TYP_CZESCI']]
    ];
    const erpAssemblyIndexProductGroupId = assemblyIndexPLMDefaults.productGroup;
    const erpAssemblyIndexProductPropertyMappings = [
        ['Opis', ['DESCRIPTION']],
        ['Nazwa', ['DESCRIPTION', 'TITLE']],
        ['Tytuł', ['TITLE']],
        ['Tutuł', ['TITLE']],
        ['Rewizja', ['REVISION']],
        ['Materiał', ['MATERIAL']],
        ['Specyfikacja', ['SPECYFIKACJA'], assemblyIndexPLMDefaults.specification],
        ['Status', ['STATUS']],
        ['Grupa produktowa', ['GRUPA_PRODUKTOWA'], assemblyIndexPLMDefaults.productGroup],
        ['Nazwa urządzenia', ['NAZWA_URZDZENIA']],
        ['Moc/Wielkość', ['MOC']],
        ['Typ części', ['TYP_CZESCI'], assemblyIndexPLMDefaults.partType],
        ['Rodzaj', ['RODZAJ'], assemblyIndexPLMDefaults.kind],
        ['Wariant', ['WARIANT'], assemblyIndexPLMDefaults.variant],
        ['Lifecycle', ['LIFECYCLE']]
    ];
    const erpTechnologyOperationCodeFieldId = 'KOD_OPERACJI';
    const erpTechnologyOperationCodeCandidates = [
        erpTechnologyOperationCodeFieldId,
        'KOD OPERACJI',
        'OPERATION_CODE',
        'OPERATION CODE',
        'KODOPERACJI'
    ];
    let erpTechnologyDetailsCache = {};

    function isERPTechnologyTestRunEnabled() {
        return $('#toggle-erp-technology-test-run').hasClass('icon-toggle-on');
    }

    function normalizeERPTechnologyIndex(value) {
        if(value === null || typeof value === 'undefined') return '';

        let normalized = String(value).trim();
        if(normalized.toUpperCase().endsWith('-M')) {
            normalized = normalized.substring(0, normalized.length - 2);
        }

        return normalized;
    }

    function normalizeERPBooleanText(value) {
        if(typeof value !== 'string') return false;
        return ['true', '1', 'yes', 'y'].includes(value.trim().toLowerCase());
    }

    function isERPTechnologySynced(detailsData) {
        let sections = (detailsData && detailsData.sections) ? detailsData.sections : [];
        let value = getSectionFieldValue(sections, 'WYSLANE_DO_ERP', '', null);

        if(value === true) return true;
        if(value === false || value === null) return false;
        if(typeof value === 'number') return value !== 0;
        if(typeof value === 'string') return normalizeERPBooleanText(value);

        if(typeof value === 'object' && value !== null) {
            if(typeof value.value === 'boolean') return value.value;
            if(typeof value.value === 'string') return normalizeERPBooleanText(value.value);
        }

        return false;
    }

    function getERPTechnologyElementLink(elemItem) {
        if(!elemItem || elemItem.length === 0) return '';

        let link = elemItem.attr('data-link-mbom') || elemItem.attr('data-link') || '';
        if(elemItem.hasClass('assembly-index')) return getPLMItemLevelLink(link);

        return link;
    }

    function getERPTechnologyDescriptor(elemItem) {
        if(!elemItem || elemItem.length === 0) return '';
        return elemItem.find('.item-head-descriptor').first().text().trim() || elemItem.find('.item-title').first().text().trim() || '';
    }

    function getERPTechnologyDirectChildItems(elemItem) {
        if(!elemItem || elemItem.length === 0) return $();
        return elemItem.children('.item-bom').children('.item');
    }

    function getERPTechnologyDirectProcessItems(elemItem) {
        return getERPTechnologyDirectChildItems(elemItem).filter(function() {
            return $(this).hasClass('process');
        });
    }

    function getERPTechnologyExpandableItems() {
        let items = [];
        let seen = new Set();

        $('#mbom-tree').find('.item').each(function() {
            let elemItem = $(this);
            if(!hasMBOMShortcut(elemItem)) return;

            let link = getERPTechnologyElementLink(elemItem) || ('dom-expand-' + items.length);
            if(seen.has(link)) return;
            seen.add(link);
            items.push(elemItem);
        });

        items.sort(function(a, b) {
            return getElementLevel(a) - getElementLevel(b);
        });

        return items;
    }

    function shouldExpandERPTechnologySubMBOM(elemItem) {
        if(!elemItem || elemItem.length === 0) return Promise.resolve(false);

        return resolveInlineSubMBOMContext(elemItem).then(function(context) {
            let expansionLink = context && context.expansionLink ? context.expansionLink : '';
            if(isBlank(expansionLink)) {
                console.log('MBOM custom: ERP technology discovery found no linked sub-MBOM to expand', {
                    link       : getERPTechnologyElementLink(elemItem),
                    descriptor : getERPTechnologyDescriptor(elemItem)
                });
                return false;
            }

            // Assembly indices must be expanded even after their ERP flag is
            // set. Their process children are required to build a subsequent
            // modify-technology request.
            if(elemItem.hasClass('assembly-index')) {
                console.log('MBOM custom: expanding assembly index for ERP technology discovery', {
                    itemLink      : getERPTechnologyElementLink(elemItem),
                    expansionLink : expansionLink,
                    descriptor    : getERPTechnologyDescriptor(elemItem)
                });
                return true;
            }

            return getERPTechnologyItemDetails(expansionLink).then(function(detailsData) {
                if(!detailsData) {
                    console.warn('MBOM custom: ERP technology discovery could not load linked sub-MBOM details, skipping expansion', {
                        itemLink       : getERPTechnologyElementLink(elemItem),
                        expansionLink  : expansionLink,
                        descriptor     : getERPTechnologyDescriptor(elemItem)
                    });
                    return false;
                }

                let alreadySynced = isERPTechnologySynced(detailsData);
                console.log('MBOM custom: ERP technology sub-MBOM sync state resolved', {
                    itemLink       : getERPTechnologyElementLink(elemItem),
                    expansionLink  : expansionLink,
                    descriptor     : getERPTechnologyDescriptor(elemItem),
                    alreadySynced  : alreadySynced
                });

                return !alreadySynced;
            }).catch(function(error) {
                console.warn('MBOM custom: ERP technology discovery failed to inspect linked sub-MBOM, skipping expansion', {
                    itemLink      : getERPTechnologyElementLink(elemItem),
                    expansionLink : expansionLink,
                    error         : error
                });
                return false;
            });
        }).catch(function(error) {
            console.warn('MBOM custom: ERP technology discovery failed to resolve inline sub-MBOM context, skipping expansion', {
                itemLink   : getERPTechnologyElementLink(elemItem),
                descriptor : getERPTechnologyDescriptor(elemItem),
                error      : error
            });
            return false;
        });
    }

    function ensureERPTechnologyTreeExpanded() {
        let processed = new Set();

        function expandPass() {
            let expandableItems = getERPTechnologyExpandableItems().filter(function(elemItem) {
                let link = getERPTechnologyElementLink(elemItem) || '';
                if(isBlank(link)) return elemItem.attr('data-inline-submbom-loaded') !== 'true' && elemItem.attr('data-inline-submbom-loaded') !== 'empty';
                return !processed.has(link);
            });

            if(expandableItems.length === 0) return Promise.resolve();

            let chain = Promise.resolve();

            expandableItems.forEach(function(elemItem) {
                chain = chain.then(function() {
                    let link = getERPTechnologyElementLink(elemItem) || ('dom-expand-' + processed.size);
                    processed.add(link);
                    
                    return shouldExpandERPTechnologySubMBOM(elemItem).then(function(shouldExpand) {
                        if(!shouldExpand) {
                            console.log('MBOM custom: skipping linked sub-MBOM expansion because ERP sync is already complete', {
                                link       : link,
                                descriptor : getERPTechnologyDescriptor(elemItem),
                                level      : getElementLevel(elemItem)
                            });
                            return false;
                        }

                        console.log('MBOM custom: expanding linked sub-MBOM for ERP technology discovery', {
                            link       : link,
                            descriptor : getERPTechnologyDescriptor(elemItem),
                            level      : getElementLevel(elemItem)
                        });

                        return ensureInlineSubMBOMExpanded(elemItem).catch(function(error) {
                            console.warn('MBOM custom: failed to expand linked sub-MBOM during ERP technology discovery', {
                                link  : link,
                                error : error
                            });
                            return false;
                        });
                    });
                });
            });

            return chain.then(expandPass);
        }

        return expandPass();
    }

    function getERPTechnologyRootItems() {
        let roots = [];
        let seen = new Set();

        $('#mbom-tree').find('.item').each(function() {
            let elemItem = $(this);
            let processChildren = getERPTechnologyDirectProcessItems(elemItem);
            if(processChildren.length === 0) return;

            let link = getERPTechnologyElementLink(elemItem) || ('dom-' + roots.length);
            if(seen.has(link)) return;
            seen.add(link);
            roots.push(elemItem);
        });

        roots.sort(function(a, b) {
            return getElementLevel(b) - getElementLevel(a);
        });

        console.log('MBOM custom: collected ERP technology roots', roots.map(function(elemItem) {
            return {
                link       : getERPTechnologyElementLink(elemItem),
                level      : getElementLevel(elemItem),
                descriptor : getERPTechnologyDescriptor(elemItem)
            };
        }));

        return roots;
    }

    function isERPTechnologyMainRootItem(elemItem) {
        if(!elemItem || elemItem.length === 0) return false;

        let mainLink = (typeof links !== 'undefined' && links && links.mbom) ? links.mbom : '';
        let itemLink = getERPTechnologyElementLink(elemItem);

        if(!isBlank(mainLink) && !isBlank(itemLink)) {
            return normalizePLMLink(mainLink) === normalizePLMLink(itemLink);
        }

        return elemItem.closest('#mbom-tree').length > 0 && elemItem.parent().attr('id') === 'mbom-tree';
    }

    function getERPTechnologyPartDetailsValue(part, candidateIds) {
        if(!part || !part.details || !Array.isArray(candidateIds)) return '';

        for(let candidateId of candidateIds) {
            if(typeof part.details[candidateId] !== 'undefined' && part.details[candidateId] !== null && part.details[candidateId] !== '') {
                return String(part.details[candidateId]).trim();
            }
        }

        let normalizedCandidates = candidateIds.map(function(candidateId) {
            return String(candidateId).toLowerCase().replace(/[^a-z0-9]/g, '');
        });

        for(let key of Object.keys(part.details)) {
            let normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
            if(normalizedCandidates.includes(normalizedKey)) {
                let value = part.details[key];
                if(value !== null && value !== '') return String(value).trim();
            }
        }

        return '';
    }

    function getERPTechnologySectionValue(sections, candidateIds, fallbackValue) {
        if(!Array.isArray(candidateIds)) return fallbackValue || '';

        for(let candidateId of candidateIds) {
            let value = getSectionFieldValue(sections, candidateId, '', 'object');
            if(typeof value === 'string' && value.trim() !== '') return value.trim();
            if(typeof value === 'number') return String(value);
            if(value && typeof value.title === 'string' && value.title.trim() !== '') return value.title.trim();
            if(value && typeof value.value === 'string' && value.value.trim() !== '') return value.value.trim();
        }

        return fallbackValue || '';
    }

    function truncateERPAssemblyIndexPropertyValue(value, maxBytes) {
        if(typeof value !== 'string') return value;

        let byteLimit = Number(maxBytes) || 40;
        let truncated = '';

        for(let char of value) {
            let nextValue = truncated + char;
            if(new TextEncoder().encode(nextValue).length > byteLimit) break;
            truncated = nextValue;
        }

        return truncated.trim();
    }

    function buildERPAssemblyIndexProductPayload(elemItem, itemPart, detailsData) {
        let sections = (detailsData && detailsData.sections) ? detailsData.sections : [];
        let rawIndex = getERPTechnologySectionValue(sections, ['NUMBER'], '');
        let title = getERPTechnologySectionValue(sections, ['TITLE'], (detailsData && detailsData.title) ? detailsData.title : '');
        let description = getERPTechnologySectionValue(sections, ['DESCRIPTION'], title);
        let groupId = getERPTechnologySectionValue(sections, ['GRUPA_PRODUKTOWA'], erpAssemblyIndexProductGroupId);
        let properties = [];

        erpAssemblyIndexProductPropertyMappings.forEach(function(mapping) {
            let value = getERPTechnologySectionValue(sections, mapping[1], '');
            if(isBlank(value) && mapping.length > 2) value = mapping[2];
            if(mapping[0] === 'Grupa produktowa' && isBlank(value)) value = groupId;
            if(mapping[0] === 'Nazwa' && isBlank(value)) value = title;
            if(mapping[0] === 'Opis' && isBlank(value)) value = description;
            if(isBlank(value)) return;

            let property = {};
            property[mapping[0]] = truncateERPAssemblyIndexPropertyValue(String(value), 40);
            properties.push(property);
        });

        return {
            indeks          : rawIndex,
            nazwa_czesci    : description || title || rawIndex,
            id_grupy        : groupId || erpAssemblyIndexProductGroupId,
            jednostka_miary : getERPTechnologyComponentUnitOfMeasure(itemPart, detailsData, elemItem),
            wlasnosci       : properties
        };
    }

    function getERPTechnologyItemDetails(link) {
        if(isBlank(link)) return Promise.resolve(null);
        if(erpTechnologyDetailsCache[link]) return Promise.resolve(erpTechnologyDetailsCache[link]);

        return $.get('/plm/details', { link : link }).then(function(response) {
            let detailsData = response && response.data ? response.data : null;
            erpTechnologyDetailsCache[link] = detailsData;
            return detailsData;
        });
    }

    function buildERPTechnologyPLMAttachmentsUrl(link) {
        if(isBlank(link)) return '';

        let linkParts = String(link || '').split('/');
        let workspaceId = linkParts[4] || '';
        let itemId = linkParts[6] || '';
        let tenantName = (typeof tenant !== 'undefined' && !isBlank(tenant)) ? String(tenant) : '';

        if(!isBlank(tenantName) && !isBlank(workspaceId) && !isBlank(itemId)) {
            return 'https://' + tenantName + '.autodeskplm360.net'
                + '/plm/workspaces/' + workspaceId + '/items/attachments'
                + '?view=full&tab=attachments&mode=view&itemId=urn%60adsk,plm%60tenant,workspace,item%60'
                + tenantName.toUpperCase() + ',' + workspaceId + ',' + itemId;
        }

        return '';
    }

    function getERPTechnologyAttachmentItemLink(elemItem, itemPart, itemLink) {
        if(itemPart && itemPart.ebom && !isBlank(itemPart.ebom.link)) {
            return itemPart.ebom.link;
        }

        if(elemItem && elemItem.length > 0) {
            let ebomLink = elemItem.attr('data-ebom') || elemItem.attr('data-link-ebom') || elemItem.attr('data-ebom-root') || '';
            if(!isBlank(ebomLink)) return ebomLink;
        }
        
        return itemLink || '';
    }

    function getERPTechnologyAttachments(link) {
        let sourceUrl = buildERPTechnologyPLMAttachmentsUrl(link);
        if(isBlank(sourceUrl)) return [];

        return [{
            zrodlo : sourceUrl,
            opis   : 'Dokumenty w PLM'
        }];
    }

    function getERPTechnologyRevision(detailsData) {
        let sections = (detailsData && detailsData.sections) ? detailsData.sections : [];
        let revision = getSectionFieldValue(sections, 'REVISION', '', null);
        if(typeof revision === 'string' && revision.trim() !== '') return revision.trim();
        if(detailsData && detailsData.workingVersion) return 'Working';
        if(detailsData && typeof detailsData.versionId !== 'undefined' && detailsData.versionId !== null) return String(detailsData.versionId);
        return '';
    }

    function getERPTechnologyApprovalStatus(detailsData) {
        let sections = (detailsData && detailsData.sections) ? detailsData.sections : [];
        let status = getSectionFieldValue(sections, 'STATUS', '', null);
        if(typeof status === 'string' && status.trim() !== '') return status.trim();
        if(detailsData && detailsData.lifecycle && detailsData.lifecycle.state && detailsData.lifecycle.state.label) return String(detailsData.lifecycle.state.label).trim();
        return '';
    }

    function buildERPTechnologyDescription(detailsData, part) {
        let sections = (detailsData && detailsData.sections) ? detailsData.sections : [];
        let description = getERPTechnologySectionValue(sections, ['DESCRIPTION'], '');
        if(isBlank(description)) {
            description = getERPTechnologySectionValue(
                sections,
                ['TITLE'],
                (detailsData && detailsData.title) ? detailsData.title : ''
            );
        }
        let technologyId = getERPTechnologySectionValue(sections, ['ID_TECHNOLOGI', 'id_technologi'], '');

        if(isBlank(technologyId) && part && part.details) {
            technologyId = getERPTechnologyPartDetailsValue(part, ['ID_TECHNOLOGI', 'id_technologi']);
        }

        if(isBlank(technologyId)) return description;
        if(isBlank(description)) return technologyId;

        return description + ' ' + technologyId;
    }

    function buildERPTechnologyProperties(detailsData) {
        let sections = (detailsData && detailsData.sections) ? detailsData.sections : [];
        let properties = [];

        erpTechnologyPropertyMappings.forEach(function(mapping) {
            let value = getERPTechnologySectionValue(sections, mapping[1], '');
            if(!isBlank(value)) {
                let property = {};
                property[mapping[0]] = value;
                properties.push(property);
            }
        });

        return properties;
    }

    function getERPTechnologyProcessNumber(processItem, processPart, processDetailsData) {
        let value = '';

        if(processPart && !isBlank(processPart.code)) value = processPart.code;
        if(isBlank(value)) value = getERPTechnologySectionValue((processDetailsData && processDetailsData.sections) ? processDetailsData.sections : [], [config.workspaceMBOM.fieldIDs.code, 'PROCESS_CODE'], '');
        if(isBlank(value) && processItem && processItem.length > 0) value = processItem.find('.item-code').first().text().trim();

        if(isBlank(value)) return '';

        let numeric = Number(value);
        if(!Number.isNaN(numeric) && String(value).indexOf('.') > -1) return String(parseInt(numeric, 10));
        return String(value).trim();
    }

    function sortERPTechnologyOperations(payload) {
        if(!payload || !Array.isArray(payload.operacje)) return;

        payload.operacje.sort(function(a, b) {
            let aValue = parseFloat(a.numer_operacji);
            let bValue = parseFloat(b.numer_operacji);

            if(Number.isNaN(aValue) && Number.isNaN(bValue)) return String(a.numer_operacji).localeCompare(String(b.numer_operacji));
            if(Number.isNaN(aValue)) return 1;
            if(Number.isNaN(bValue)) return -1;

            return aValue - bValue;
        });
    }

    function sortERPTechnologyStructure(payload) {
        if(!payload || !Array.isArray(payload.struktura)) return;

        payload.struktura.sort(function(a, b) {
            let aValue = parseFloat(a.numer_operacji);
            let bValue = parseFloat(b.numer_operacji);

            if(Number.isNaN(aValue) && Number.isNaN(bValue)) return String(a.numer_operacji).localeCompare(String(b.numer_operacji));
            if(Number.isNaN(aValue)) return 1;
            if(Number.isNaN(bValue)) return -1;
            if(aValue !== bValue) return aValue - bValue;

            return String(a.indeks_skladowy).localeCompare(String(b.indeks_skladowy));
        });
    }

    function getERPTechnologyOperationCode(processPart, processDetailsData, processItem) {
        let sections = (processDetailsData && processDetailsData.sections) ? processDetailsData.sections : [];
        let value = getERPTechnologySectionValue(sections, erpTechnologyOperationCodeCandidates, '');
        if(isBlank(value)) value = getERPTechnologyPartDetailsValue(processPart, erpTechnologyOperationCodeCandidates);
        if(isBlank(value) && processItem && processItem.length > 0) {
            value = processItem.attr('data-operation-code') || '';
        }
        if(isBlank(value)) value = getERPTechnologyDescriptor(processItem);
        return value;
    }

    function getERPTechnologyComponentQuantity(elemItem, part) {
        if(elemItem && elemItem.length > 0) {
            let elemQty = elemItem.find('.item-qty-input').first();
            let value = elemQty.length > 0 ? elemQty.val() : '';
            if(isBlank(value)) value = elemItem.attr('data-qty') || elemItem.children('.item-head').attr('data-qty') || '';
            let number = parseFloat(value);
            if(!Number.isNaN(number)) return number;
        }

        if(part && !isBlank(part.quantity)) {
            let number = parseFloat(part.quantity);
            if(!Number.isNaN(number)) return number;
        }

        return 1;
    }

    function normalizeERPTechnologyUnitOfMeasure(value) {
        if(isBlank(value)) return 'szt';

        let source = String(value).trim();
        let normalized = source.toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ');

        let mappings = {
            'day' : 'db', 'days' : 'db', 'doba' : 'db', 'db' : 'db',
            'watt' : 'W', 'watts' : 'W', 'w' : 'W',
            'six-pack' : 'pk-06', 'six pack' : 'pk-06', 'szescio-pack' : 'pk-06', 'pk-06' : 'pk-06',
            'four-pack' : 'pk-04', 'four pack' : 'pk-04', 'cztero-pack' : 'pk-04', 'pk-04' : 'pk-04',
            'eight-pack' : 'pk-08', 'eight pack' : 'pk-08', 'osmio-pack' : 'pk-08', 'pk-08' : 'pk-08',
            'linear meter' : 'mb', 'linear metre' : 'mb', 'metr biezacy' : 'mb', 'mb' : 'mb',
            'kelvin' : '°K', 'degree kelvin' : '°K', 'stopnien kalvina' : '°K', '°k' : '°K',
            'each' : 'szt', 'piece' : 'szt', 'pieces' : 'szt', 'sztuka' : 'szt', 'szt' : 'szt', 'szt.' : 'szt',
            'package' : 'opak', 'packaging' : 'opak', 'opakowanie' : 'opak', 'opak' : 'opak',
            'meter' : 'm', 'meters' : 'm', 'metre' : 'm', 'metres' : 'm', 'metr' : 'm', 'm' : 'm',
            'kilogram' : 'kg', 'kilograms' : 'kg', 'kg' : 'kg',
            'liter' : 'l', 'liters' : 'l', 'litre' : 'l', 'litres' : 'l', 'litr' : 'l', 'l' : 'l',
            'millimeter' : 'mm', 'millimeters' : 'mm', 'millimetre' : 'mm', 'millimetres' : 'mm', 'milimetr' : 'mm', 'mm' : 'mm',
            'cubic meter' : 'm3', 'cubic metre' : 'm3', 'metr szescienny' : 'm3', 'm³' : 'm3', 'm^3' : 'm3', 'm3' : 'm3',
            'square meter' : 'm2', 'square metre' : 'm2', 'metr kwadratowy' : 'm2', 'm²' : 'm2', 'm^2' : 'm2', 'm2' : 'm2',
            'cubic decimeter' : 'dm3', 'cubic decimetre' : 'dm3', 'decymetr szescienny' : 'dm3', 'dm³' : 'dm3', 'dm^3' : 'dm3', 'dm3' : 'dm3',
            'kilowatt' : 'kW', 'kilowatts' : 'kW', 'kw' : 'kW',
            'kilowatt hour' : 'kWh', 'kilowatt-hour' : 'kWh', 'kilowatogodzina' : 'kWh', 'kwh' : 'kWh',
            'gram' : 'g', 'grams' : 'g', 'g' : 'g',
            'tonne' : 't', 'tonnes' : 't', 'metric ton' : 't', 'metric tonne' : 't', 'tona' : 't', 't' : 't',
            'milliliter' : 'ml', 'milliliters' : 'ml', 'millilitre' : 'ml', 'millilitres' : 'ml', 'mililitr' : 'ml', 'ml' : 'ml',
            'set' : 'kpl', 'complete set' : 'kpl', 'komplet' : 'kpl', 'kpl' : 'kpl',
            'celsius' : '°C', 'degree celsius' : '°C', 'stopien celsjusza' : '°C', '°c' : '°C',
            'centimeter' : 'cm', 'centimeters' : 'cm', 'centimetre' : 'cm', 'centimetres' : 'cm', 'centymetr' : 'cm', 'cm' : 'cm',
            'fahrenheit' : '°F', 'degree fahrenheit' : '°F', 'stopien fahreheita' : '°F', 'stopien fahrenheita' : '°F', '°f' : '°F',
            'inch' : '"', 'inches' : '"', 'in' : '"', 'cal' : '"', '"' : '"',
            'cubic centimeter' : 'cm3', 'cubic centimetre' : 'cm3', 'centymetr szescienny' : 'cm3', 'cm³' : 'cm3', 'cm^3' : 'cm3', 'cm3' : 'cm3',
            'second' : '``', 'seconds' : '``', 'sekunda' : '``', 's' : '``', '``' : '``',
            'minute' : "'", 'minutes' : "'", 'minuta' : "'", 'min' : "'", "'" : "'",
            'square centimeter' : 'cm2', 'square centimetre' : 'cm2', 'centymetr kwadratowy' : 'cm2', 'cm²' : 'cm2', 'cm^2' : 'cm2', 'cm2' : 'cm2',
            'decimeter' : 'dm', 'decimetre' : 'dm', 'decymetr' : 'dm', 'dm' : 'dm',
            'square decimeter' : 'dm2', 'square decimetre' : 'dm2', 'decymetr kwadratowy' : 'dm2', 'dm²' : 'dm2', 'dm^2' : 'dm2', 'dm2' : 'dm2',
            'square millimeter' : 'mm2', 'square millimetre' : 'mm2', 'milimetr kwadratowy' : 'mm2', 'mm²' : 'mm2', 'mm^2' : 'mm2', 'mm2' : 'mm2',
            'cubic millimeter' : 'mm3', 'cubic millimetre' : 'mm3', 'milimetr szescienny' : 'mm3', 'mm³' : 'mm3', 'mm^3' : 'mm3', 'mm3' : 'mm3',
            'ac volt' : 'V~', 'volt ac' : 'V~', 'volt pradu zmiennego' : 'V~', 'v~' : 'V~',
            'radian' : '°R', 'radians' : '°R', 'degree radian' : '°R', 'stopien radiana' : '°R', '°r' : '°R'
        };

        return mappings[normalized] || source;
    }

    function getERPTechnologyComponentUnitOfMeasure(part, detailsData, elemItem) {
        let sections = (detailsData && detailsData.sections) ? detailsData.sections : [];
        let fieldIds = (typeof config !== 'undefined' && config.workspaceMBOM && config.workspaceMBOM.fieldIDs)
            ? config.workspaceMBOM.fieldIDs
            : {};

        let candidateIds = [
            fieldIds.unitOfMeasure,
            fieldIds.uom,
            'UNIT_OF_MEASURE',
            'UOM',
            'UNIT',
            'BOM_UOM',
            'ITEM_UOM'
        ].filter(Boolean);

        let value = getERPTechnologySectionValue(sections, candidateIds, '');
        if(isBlank(value) && part) {
            if(!isBlank(part.unitOfMeasure)) value = part.unitOfMeasure;
            if(isBlank(value) && !isBlank(part.uom)) value = part.uom;
            if(isBlank(value)) value = getERPTechnologyPartDetailsValue(part, candidateIds);
        }

        if(isBlank(value) && elemItem && elemItem.length > 0) {
            value = elemItem.attr('data-unit-of-measure') || elemItem.attr('data-uom') || '';
        }

        return normalizeERPTechnologyUnitOfMeasure(value);
    }

    function isERPTechnologyManufacturingPart(part, detailsData) {
        let typeValue = '';

        if(part && !isBlank(part.type)) typeValue = part.type;
        if(isBlank(typeValue) && detailsData && detailsData.sections) typeValue = getERPTechnologySectionValue(detailsData.sections, [config.workspaceMBOM.fieldIDs.type, 'TYPE'], '');
        if(typeof typeValue !== 'string') return false;

        return typeValue.trim().toLowerCase() === 'manufacturing';
    }

    function getERPTechnologyComponentPartIndex(part, detailsData, elemItem) {
        let sections = (detailsData && detailsData.sections) ? detailsData.sections : [];
        let fieldIds = (typeof config !== 'undefined' && config.workspaceMBOM && config.workspaceMBOM.fieldIDs)
            ? config.workspaceMBOM.fieldIDs
            : {};
        let numberValue = getERPTechnologySectionValue(sections, [
            fieldIds.erpPartIndex || 'INDEKS_CZESCI',
            'INDEKS_CZESCI',
            'indeks_czesci'
        ], '');

        if(isBlank(numberValue) && part && part.details) {
            numberValue = getERPTechnologyPartDetailsValue(part, [
                fieldIds.erpPartIndex || 'INDEKS_CZESCI',
                'INDEKS_CZESCI',
                'indeks_czesci'
            ]);
        }

        if(isBlank(numberValue)) {
            numberValue = getERPTechnologySectionValue(sections, [
                fieldIds.number || 'NUMBER',
                'NUMBER',
                'number',
                'ITEM_NUMBER',
                'item_number'
            ], '');
        }

        if(isBlank(numberValue) && part) {
            numberValue = getPartNumber(part);
        }

        return normalizeERPTechnologyIndex(numberValue);
    }

    function getERPTechnologyComponentVersionId(part, detailsData) {
        function normalizeERPVersionIdValue(value) {
            if(value === null || typeof value === 'undefined' || value === '') return '';

            let normalized = Number(value);
            if(Number.isNaN(normalized)) return '';

            return Math.trunc(normalized);
        }

        let sections = (detailsData && detailsData.sections) ? detailsData.sections : [];
        let fieldIds = (typeof config !== 'undefined' && config.workspaceMBOM && config.workspaceMBOM.fieldIDs)
            ? config.workspaceMBOM.fieldIDs
            : {};
        let versionValue = getERPTechnologySectionValue(sections, [
            fieldIds.erpVersionId || 'ID_WERSJI',
            'ID_WERSJI',
            'id_wersji'
        ], '');

        if(isBlank(versionValue) && part && part.details) {
            versionValue = getERPTechnologyPartDetailsValue(part, [
                fieldIds.erpVersionId || 'ID_WERSJI',
                'ID_WERSJI',
                'id_wersji'
            ]);
        }

        if(isBlank(versionValue) && part && typeof part.versionId !== 'undefined' && part.versionId !== null) {
            versionValue = part.versionId;
        }

        if(isBlank(versionValue) && detailsData && typeof detailsData.versionId !== 'undefined' && detailsData.versionId !== null) {
            versionValue = detailsData.versionId;
        }

        return normalizeERPVersionIdValue(versionValue);
    }

    function buildERPTechnologyPayload(elemItem) {
        let itemLink = getERPTechnologyElementLink(elemItem);
        let itemPart = getMBOMPartFromElement(elemItem);
        let processItems = getERPTechnologyDirectProcessItems(elemItem).get();

        return getERPTechnologyItemDetails(itemLink).then(function(detailsData) {
            if(!detailsData) return null;

            let sections = detailsData.sections || [];
            let technologyVersionId = getERPTechnologyComponentVersionId(itemPart, detailsData);
            let alreadySynced = isERPTechnologySynced(detailsData);
            let payload = {
                indeks          : normalizeERPTechnologyIndex(getERPTechnologySectionValue(sections, ['NUMBER'], '')),
                nazwa_czesci    : getERPTechnologySectionValue(sections, ['TITLE'], detailsData.title || ''),
                opis            : buildERPTechnologyDescription(detailsData, itemPart),
                rewizja         : getERPTechnologyRevision(detailsData),
                czy_zatwierdzona: 'N',
                id_wersji       : technologyVersionId,
                wlasnosci       : buildERPTechnologyProperties(detailsData),
                operacje        : [],
                struktura       : [],
                zalaczniki      : []
            };

            if(isBlank(technologyVersionId) || !alreadySynced) {
                delete payload.id_wersji;
            }

            if(alreadySynced) {
                payload.zablokowana = 'N';
            }

            payload.zalaczniki = getERPTechnologyAttachments(getERPTechnologyAttachmentItemLink(elemItem, itemPart, itemLink));

            let processPromises = processItems.map(function(processItem) {
                let elemProcess = $(processItem);
                let processPart = getMBOMPartFromElement(elemProcess);
                let processLink = getERPTechnologyElementLink(elemProcess);

                return getERPTechnologyItemDetails(processLink).then(function(processDetailsData) {
                    let processNumber = getERPTechnologyProcessNumber(elemProcess, processPart, processDetailsData);
                    let operationCode = getERPTechnologyOperationCode(processPart, processDetailsData, elemProcess);

                    payload.operacje.push({
                        numer_operacji : processNumber,
                        kod_operacji   : operationCode,
                        gniazdo        : 'xxxx',
                        stanowisko     : 'wirtualne'
                    });

                    let structureItems = getERPTechnologyDirectChildItems(elemProcess).get();
                    let structurePromises = structureItems.map(function(structureItem) {
                        let elemStructure = $(structureItem);
                        let structurePart = getMBOMPartFromElement(elemStructure);
                        let structureLink = getERPTechnologyElementLink(elemStructure);

                        return getERPTechnologyItemDetails(structureLink).then(function(structureDetailsData) {
                            let isManufacturingPart = isERPTechnologyManufacturingPart(structurePart, structureDetailsData);
                            let structureVersionId = getERPTechnologyComponentVersionId(structurePart, structureDetailsData);
                            let structureRow = {
                                numer_operacji  : processNumber,
                                indeks_skladowy : getERPTechnologyComponentPartIndex(structurePart, structureDetailsData, elemStructure),
                                rewizja         : isManufacturingPart ? getERPTechnologyRevision(structureDetailsData) : '',
                                ilosc_stala     : 0,
                                ilosc_jednostek : getERPTechnologyComponentQuantity(elemStructure, structurePart),
                                jednostka_miary : getERPTechnologyComponentUnitOfMeasure(structurePart, structureDetailsData, elemStructure)
                            };

                            if(!isBlank(structureVersionId)) {
                                structureRow.id_wersji_skladowej = structureVersionId;
                            }

                            payload.struktura.push(structureRow);
                        });
                    });

                    return Promise.all(structurePromises);
                });
            });

            return Promise.all(processPromises).then(function() {
                sortERPTechnologyOperations(payload);
                sortERPTechnologyStructure(payload);

                let assemblyIndex = (elemItem && elemItem.hasClass('assembly-index')) || isAssemblyIndexNode(itemPart);

                return {
                    elemItem       : elemItem,
                    link           : itemLink,
                    descriptor     : getERPTechnologyDescriptor(elemItem),
                    level          : getElementLevel(elemItem),
                    synced         : alreadySynced,
                    isAssemblyIndex: assemblyIndex,
                    productPayload : assemblyIndex ? buildERPAssemblyIndexProductPayload(elemItem, itemPart, detailsData) : null,
                    payload        : payload
                };
            });
        });
    }

    function orderERPTechnologyJobsBottomUp(jobs) {
        let jobsByIndex = new Map();
        let ordered = [];
        let visiting = new Set();
        let visited = new Set();

        jobs.forEach(function(job) {
            if(!isBlank(job.payload.indeks)) jobsByIndex.set(job.payload.indeks, job);
        });

        function visit(job) {
            if(!job || visited.has(job.link)) return;
            if(visiting.has(job.link)) return;

            visiting.add(job.link);

            job.payload.struktura.forEach(function(structureRow) {
                let dependency = jobsByIndex.get(structureRow.indeks_skladowy);
                if(dependency) visit(dependency);
            });

            visiting.delete(job.link);
            visited.add(job.link);
            ordered.push(job);
        }

        jobs.forEach(visit);

        console.log('MBOM custom: ERP technology jobs ordered bottom-up', ordered.map(function(job, index) {
            return {
                order      : index + 1,
                indeks     : job.payload.indeks,
                descriptor : job.descriptor,
                level      : job.level
            };
        }));

        return ordered;
    }

    function collectERPTechnologyJobs() {
        erpTechnologyDetailsCache = {};

        return ensureERPTechnologyTreeExpanded().then(function() {
            let technologyRoots = getERPTechnologyRootItems();
            if(technologyRoots.length === 0) return [];

            return Promise.all(technologyRoots.map(function(elemItem) {
                if(isERPTechnologyMainRootItem(elemItem) || elemItem.hasClass('assembly-index')) {
                    return buildERPTechnologyPayload(elemItem);
                }

                let itemLink = getERPTechnologyElementLink(elemItem);
                if(isBlank(itemLink)) {
                    console.warn('MBOM custom: skipping sub-MBOM technology because its ERP sync state cannot be checked', {
                        descriptor : getERPTechnologyDescriptor(elemItem),
                        level      : getElementLevel(elemItem)
                    });
                    return Promise.resolve(null);
                }

                return getERPTechnologyItemDetails(itemLink).then(function(detailsData) {
                    if(!detailsData) {
                        console.warn('MBOM custom: skipping sub-MBOM technology because its details could not be loaded', {
                            link       : itemLink,
                            descriptor : getERPTechnologyDescriptor(elemItem)
                        });
                        return null;
                    }

                    if(isERPTechnologySynced(detailsData)) {
                        console.log('MBOM custom: skipping already synced sub-MBOM before loading its technology structure', {
                            link       : itemLink,
                            descriptor : getERPTechnologyDescriptor(elemItem),
                            level      : getElementLevel(elemItem)
                        });
                        return null;
                    }

                    return buildERPTechnologyPayload(elemItem);
                }).catch(function(error) {
                    console.warn('MBOM custom: skipping sub-MBOM technology because its ERP sync state could not be checked', {
                        link       : itemLink,
                        descriptor : getERPTechnologyDescriptor(elemItem),
                        error      : error
                    });
                    return null;
                });
            })).then(function(jobs) {
                let filteredJobs = jobs.filter(function(job) {
                    return job !== null && job.payload && !isBlank(job.payload.indeks) && Array.isArray(job.payload.operacje) && job.payload.operacje.length > 0;
                });

                filteredJobs = filteredJobs.filter(function(job) {
                    if(isERPTechnologyMainRootItem(job.elemItem)) return true;
                    if(job.isAssemblyIndex) return true;
                    return !job.synced;
                });

                return orderERPTechnologyJobsBottomUp(filteredJobs);
            });
        });
    }

    function previewERPTechnologies() {
        let elemButton = $('#preview-erp-technologies');
        if(elemButton.hasClass('disabled')) return;

        elemButton.addClass('disabled').text('Building...');
        setERPStatusOutput('Building ERP technology payloads', {
            timestamp : new Date().toISOString()
        }, false);

        collectERPTechnologyJobs().then(function(jobs) {
            if(jobs.length === 0) {
                setERPStatusOutput('No ERP technology payloads found', {
                    message : 'No process-based technology roots are available in the current MBOM.'
                }, true);
                return;
            }

            let previewItems = [];

            jobs.forEach(function(job) {
                if(job.isAssemblyIndex && !job.synced) {
                    previewItems.push({
                        order      : previewItems.length + 1,
                        callName   : 'add-product',
                        indeks     : job.productPayload ? job.productPayload.indeks : '',
                        descriptor : job.descriptor,
                        payload    : job.productPayload
                    });
                }

                previewItems.push({
                    order      : previewItems.length + 1,
                    callName   : job.synced ? 'modify-technology' : 'add-technology',
                    indeks     : job.payload.indeks,
                    descriptor : job.descriptor,
                    payload    : job.payload
                });
            });

            setERPStatusOutput('ERP technology payload preview', {
                requestCount : previewItems.length,
                message      : 'The currently opened MBOM will send ' + previewItems.length + ' ERP request(s).',
                requests     : previewItems
            }, false);
        }).catch(function(error) {
            console.warn('MBOM custom: failed to build ERP technology payloads', error);
            setERPStatusOutput('Building ERP technology payloads failed', {
                error : String(error || '')
            }, true);
        }).finally(function() {
            elemButton.removeClass('disabled').text('Preview Technology JSON');
        });
    }

    function updateERPTechnologySyncFields(link, erpResponseBody) {
        if(isBlank(link)) {
            return Promise.resolve(false);
        }

        let fieldIds = (typeof config !== 'undefined' && config.workspaceMBOM && config.workspaceMBOM.fieldIDs)
            ? config.workspaceMBOM.fieldIDs
            : {};
        let fieldIdERPSent = fieldIds.erpSent || 'WYSLANE_DO_ERP';
        let fieldIdERPVersion = fieldIds.erpVersionId || 'ID_WERSJI';
        let fieldIdERPPartIndex = fieldIds.erpPartIndex || 'INDEKS_CZESCI';

        function normalizeERPTextValue(value) {
            if(value === null || typeof value === 'undefined') return '';
            return String(value);
        }

        function normalizeERPIntegerValue(value) {
            if(value === null || typeof value === 'undefined' || value === '') return '';

            let normalized = Number(value);
            if(Number.isNaN(normalized)) return '';

            return Math.trunc(normalized);
        }

        function resolveFieldSectionId(sections, fieldId) {
            if(typeof getFieldSectionId === 'function') {
                let resolvedId = getFieldSectionId(sections, fieldId);
                return resolvedId === -1 ? '' : resolvedId;
            }

            if(!Array.isArray(sections) || isBlank(fieldId)) return '';

            for(let section of sections) {
                if(section && Array.isArray(section.fields)) {
                    for(let field of section.fields) {
                        if(!field || !field.link) continue;
                        let parts = String(field.link).split('/');
                        if(parts[parts.length - 1] === fieldId) {
                            let sectionParts = String(section.link || '').split('/');
                            return section.id || sectionParts[sectionParts.length - 1] || '';
                        }
                    }
                }

                if(section && section.type === 'MATRIX' && Array.isArray(section.matrices)) {
                    for(let matrix of section.matrices) {
                        if(!matrix || !Array.isArray(matrix.fields)) continue;
                        for(let matrixFields of matrix.fields) {
                            if(!Array.isArray(matrixFields)) continue;
                            for(let matrixField of matrixFields) {
                                if(!matrixField || typeof matrixField === 'string' || !matrixField.link) continue;
                                let parts = String(matrixField.link).split('/');
                                if(parts[parts.length - 1] === fieldId) {
                                    let sectionParts = String(section.link || '').split('/');
                                    return section.id || sectionParts[sectionParts.length - 1] || '';
                                }
                            }
                        }
                    }
                }
            }

            return '';
        }

        return $.get('/plm/sections', { link : link }).then(function(response) {
            let sections = response && response.data ? response.data : [];
            let params = {
                link     : link,
                sections : sections,
                fields   : []
            };
            let fieldsRequested = [];

            function addERPField(fieldId, value, type) {
                if(isBlank(fieldId)) return;
                if(value === null || typeof value === 'undefined') return;

                let sectionId = resolveFieldSectionId(sections, fieldId);
                if(isBlank(sectionId)) {
                    console.warn('MBOM custom: ERP sync field section could not be resolved', {
                        link    : link,
                        fieldId : fieldId,
                        value   : value
                    });
                    return;
                }

                let fieldPayload = {
                    fieldId   : fieldId,
                    sectionId : sectionId,
                    value     : value
                };
                if(!isBlank(type)) fieldPayload.type = type;

                params.fields.push(fieldPayload);
                fieldsRequested.push(fieldId);
            }

            addERPField(fieldIdERPSent, 'true');
            if(erpResponseBody && typeof erpResponseBody === 'object') {
                addERPField(fieldIdERPVersion, normalizeERPIntegerValue(erpResponseBody.id_wersji), 'integer');
                addERPField(fieldIdERPPartIndex, normalizeERPTextValue(erpResponseBody.indeks_czesci));
            }

            if(fieldsRequested.length === 0) return false;

            console.log('MBOM custom: updating ERP sync fields with resolved section payload', {
                link            : link,
                fieldsRequested : fieldsRequested,
                erpResponseBody : erpResponseBody
            });

            return $.post('/plm/edit', params).then(function(responseEdit) {
                if(responseEdit && responseEdit.error) {
                    console.warn('MBOM custom: PLM rejected ERP sync field update', {
                        link            : link,
                        fieldsRequested : fieldsRequested,
                        erpResponseBody : erpResponseBody,
                        response        : responseEdit
                    });
                    return false;
                }

                return true;
            });
        }).catch(function(error) {
            console.warn('MBOM custom: failed to prepare ERP sync field update', {
                link            : link,
                erpResponseBody : erpResponseBody,
                error           : error
            });
            return false;
        });
    }

    function getERPRequestFailureDetails(error) {
        if(!error) return { status : null, message : 'Unknown ERP request error', requestDump : '', responseDump : '' };

        let response = error.responseJSON || {};
        let responseData = response && response.data ? response.data : {};
        let responseBody = responseData.response || responseData.body || responseData;
        let message = error.statusText || '';

        if(response && !isBlank(response.message)) message = response.message;
        if(responseBody && typeof responseBody === 'object') {
            message = responseBody.message || responseBody.error || message;
        } else if(!isBlank(responseBody)) {
            message = String(responseBody);
        }

        return {
            status       : Number(error.status) || Number(response.status) || null,
            message      : message || 'ERP request failed',
            requestDump  : responseData.requestDumpUrl || '',
            responseDump : responseData.dumpUrl || ''
        };
    }

    function ensureERPAssemblyIndexProduct(currentJob, testRun, results) {
        if(!currentJob || !currentJob.isAssemblyIndex || currentJob.synced) {
            return Promise.resolve(true);
        }

        let payload = currentJob.productPayload || {};
        let missingFields = [];

        if(isBlank(payload.indeks)) missingFields.push('NUMBER -> indeks');
        if(isBlank(payload.nazwa_czesci)) missingFields.push('DESCRIPTION/TITLE -> nazwa_czesci');
        if(isBlank(payload.id_grupy)) missingFields.push('GRUPA_PRODUKTOWA -> id_grupy');

        if(missingFields.length > 0) {
            results.push({
                order      : results.length + 1,
                callName   : 'add-product',
                indeks     : payload.indeks || '',
                descriptor : currentJob.descriptor,
                testRun    : testRun,
                success    : false,
                error      : 'Assembly index product payload is incomplete: ' + missingFields.join(', ')
            });
            return Promise.resolve(false);
        }

        let callName = 'add-product';
        let requestUrl = testRun
            ? erpTechnologyProxyBaseUrl + 'export-request/' + callName
            : erpTechnologyProxyBaseUrl + callName;

        console.log('MBOM custom: sending assembly index ERP product prerequisite', {
            testRun    : testRun,
            callName   : callName,
            indeks     : payload.indeks,
            descriptor : currentJob.descriptor
        });

        return $.post(requestUrl, payload, null, 'json').then(function(response) {
            let status = Number(response && response.status);
            let success = !!response && !response.error && status === 200;

            results.push({
                order       : results.length + 1,
                callName    : callName,
                indeks      : payload.indeks,
                descriptor  : currentJob.descriptor,
                testRun     : testRun,
                status      : status,
                success     : success,
                requestDump : response && response.data ? response.data.requestDumpUrl : '',
                responseDump: response && response.data ? response.data.dumpUrl : '',
                error       : success ? '' : ((response && response.message) || 'ERP add-product did not return status 200.')
            });

            return success;
        }).catch(function(error) {
            let failure = getERPRequestFailureDetails(error);

            results.push({
                order       : results.length + 1,
                callName    : callName,
                indeks      : payload.indeks,
                descriptor  : currentJob.descriptor,
                testRun     : testRun,
                status      : failure.status,
                success     : false,
                requestDump : failure.requestDump,
                responseDump: failure.responseDump,
                error       : failure.message
            });

            return false;
        });
    }

    function syncERPTechnologies() {
        let elemButton = $('#sync-erp-technologies');
        if(elemButton.hasClass('disabled')) return;
        let testRun = isERPTechnologyTestRunEnabled();

        elemButton.addClass('disabled').text('Syncing...');
        setERPStatusOutput(testRun ? 'Exporting ERP technology request JSON' : 'Syncing ERP technologies', {
            timestamp : new Date().toISOString(),
            testRun   : testRun
        }, false);

        collectERPTechnologyJobs().then(function(jobs) {
            if(jobs.length === 0) {
                setERPStatusOutput('No ERP technology payloads found', {
                    message : 'No process-based technology roots are available in the current MBOM.'
                }, true);
                return;
            }

            let results = [];
            let chain = Promise.resolve();

            jobs.forEach(function(job, index) {
                chain = chain.then(function() {
                    erpTechnologyDetailsCache = {};

                    return buildERPTechnologyPayload(job.elemItem).then(function(currentJob) {
                        if(!currentJob || !currentJob.payload || isBlank(currentJob.payload.indeks) || !Array.isArray(currentJob.payload.operacje) || currentJob.payload.operacje.length === 0) {
                            results.push({
                                order      : results.length + 1,
                                callName   : 'skipped',
                                indeks     : '',
                                descriptor : getERPTechnologyDescriptor(job.elemItem),
                                success    : false,
                                error      : 'Could not rebuild ERP technology payload before sending.'
                            });
                            return null;
                        }

                        if(!isERPTechnologyMainRootItem(currentJob.elemItem) && currentJob.synced && !currentJob.isAssemblyIndex) {
                            console.log('MBOM custom: skipping ERP calls for already synced sub-MBOM item', {
                                link       : currentJob.link,
                                indeks     : currentJob.payload.indeks,
                                descriptor : currentJob.descriptor,
                                erpSent    : true
                            });
                            return null;
                        }

                        return ensureERPAssemblyIndexProduct(currentJob, testRun, results).then(function(productReady) {
                            if(!productReady) {
                                console.warn('MBOM custom: skipping ERP technology because assembly index product prerequisite failed', {
                                    indeks     : currentJob.productPayload ? currentJob.productPayload.indeks : '',
                                    descriptor : currentJob.descriptor
                                });
                                return null;
                            }

                            let callName = currentJob.synced ? 'modify-technology' : 'add-technology';
                            let requestUrl = testRun
                                ? erpTechnologyProxyBaseUrl + 'export-request/' + callName
                                : erpTechnologyProxyBaseUrl + callName;

                            console.log('MBOM custom: sending ERP technology job', {
                                order      : results.length + 1,
                                testRun    : testRun,
                                callName   : callName,
                                indeks     : currentJob.payload.indeks,
                                descriptor : currentJob.descriptor
                            });

                            return $.post(requestUrl, currentJob.payload, null, 'json').then(function(response) {
                                let status = Number(response && response.status);
                                let success = !!response && !response.error && status === 200;
                                let erpResponseBody = response && response.data ? response.data.body : null;
                                console.log('MBOM custom: ERP technology raw response payload', {
                                    callName        : callName,
                                    status          : status,
                                    testRun         : testRun,
                                    rawResponse     : response,
                                    erpResponseBody : erpResponseBody
                                });
                                let flagUpdatePromise = (!testRun && success)
                                    ? updateERPTechnologySyncFields(currentJob.link, erpResponseBody)
                                    : Promise.resolve(false);

                                return flagUpdatePromise.then(function(flagUpdated) {
                                    if(flagUpdated) erpTechnologyDetailsCache = {};

                                    results.push({
                                        order       : results.length + 1,
                                        callName    : callName,
                                        indeks      : currentJob.payload.indeks,
                                        descriptor  : currentJob.descriptor,
                                        testRun     : testRun,
                                        status      : status,
                                        success     : success,
                                        requestDump : response && response.data ? response.data.requestDumpUrl : '',
                                        responseDump: response && response.data ? response.data.dumpUrl : '',
                                        flagUpdated : flagUpdated,
                                        error       : success ? '' : ((response && response.message) || 'ERP technology request did not return status 200.')
                                    });
                                });
                            });
                        });
                    }).catch(function(error) {
                        results.push({
                            order      : results.length + 1,
                            callName   : 'rebuild-or-sync',
                            indeks     : job.payload ? job.payload.indeks : '',
                            descriptor : job.descriptor,
                            success    : false,
                            error      : String(error || '')
                        });
                    });
                });
            });

            return chain.then(function() {
                renderERPTechnologySyncResults(
                    testRun ? 'ERP technology request export finished' : 'ERP technology sync finished',
                    results,
                    results.some(function(result) { return !result.success; }),
                    testRun
                );
            });
        }).catch(function(error) {
            console.warn('MBOM custom: ERP technology sync failed', error);
            setERPStatusOutput('ERP technology sync failed', {
                error : String(error || '')
            }, true);
        }).finally(function() {
            elemButton.removeClass('disabled').text('Sync Technology to ERP');
        });
    }

    function formatERPStatusPayload(payload) {
        if(typeof payload === 'string') {
            try {
                return JSON.stringify(JSON.parse(payload), null, 2);
            } catch(error) {
                return payload;
            }
        }

        if(payload && typeof payload === 'object') {
            try {
                return JSON.stringify(payload, null, 2);
            } catch(error) {
                return String(payload);
            }
        }

        return String(payload);
    }

    function setERPStatusHtml(title, html, isError) {
        let elemOutput = $('#erp-status-output');
        if(elemOutput.length === 0) return;

        elemOutput
            .toggleClass('error', !!isError)
            .html('<div class="erp-status-heading">' + escapeERPStatusHtml(title) + '</div>' + html);
    }

    function setERPStatusOutput(title, payload, isError) {
        let text = formatERPStatusPayload(payload);
        setERPStatusHtml(title, '<pre>' + escapeERPStatusHtml(text) + '</pre>', isError);
    }

    function renderERPTechnologySyncResults(title, results, isError, testRun) {
        let successCount = results.filter(function(result) { return result.success; }).length;
        let failedCount = results.length - successCount;
        let html = '<div class="erp-status-run">';

        results.forEach(function(result) {
            let descriptor = escapeERPStatusHtml(result.descriptor || result.indeks || '');
            let callName = escapeERPStatusHtml(result.callName || 'ERP');

            html += '<div class="erp-status-line">Found next record to process</div>';
            html += '<div class="erp-status-line">- Processing "' + descriptor + '"</div>';

            if(result.success) {
                html += '<div class="erp-status-line">ERP ' + callName + ' succeeded for "' + descriptor + '"</div>';
            } else {
                html += '<div class="erp-status-line error">ERP ' + callName + ' failed for "' + descriptor + '"</div>';
            }

            if(result.requestDump) {
                html += '<div class="erp-status-line">ERP request file: <a target="_blank" href="' + escapeERPStatusHtml(result.requestDump) + '">Open JSON request</a></div>';
            }

            if(!testRun && result.responseDump) {
                html += '<div class="erp-status-line">ERP response file: <a target="_blank" href="' + escapeERPStatusHtml(result.responseDump) + '">Open JSON dump</a></div>';
            }

            if(result.error) {
                html += '<div class="erp-status-line error">Error: ' + escapeERPStatusHtml(result.error) + '</div>';
            }

            html += '<div class="erp-status-line">&nbsp;</div>';
        });

        html += '<div class="erp-status-line"><strong>SUMMARY</strong></div>';
        html += '<div class="erp-status-line">Successful items: ' + successCount + '</div>';
        html += '<div class="erp-status-line">Failed items: ' + failedCount + '</div>';
        html += '</div>';

        setERPStatusHtml(title, html, isError);
    }

    function copyERPStatusOutput() {
        let elemOutput = $('#erp-status-output');
        let elemButton = $('#copy-erp-status');
        if(elemOutput.length === 0 || elemButton.length === 0) return;

        let text = elemOutput.text() || '';
        if(text === '') return;

        let setCopiedState = function(label) {
            elemButton.text(label);
            setTimeout(function() {
                elemButton.text('Copy Response');
            }, 1500);
        };

        if(navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(text)
                .then(function() {
                    setCopiedState('Copied');
                })
                .catch(function() {
                    window.getSelection().removeAllRanges();
                    let range = document.createRange();
                    range.selectNodeContents(elemOutput[0]);
                    window.getSelection().addRange(range);
                    setCopiedState('Select and Copy');
                });
            return;
        }

        window.getSelection().removeAllRanges();
        let range = document.createRange();
        range.selectNodeContents(elemOutput[0]);
        window.getSelection().addRange(range);
        setCopiedState('Select and Copy');
    }

    function checkERPStatus() {
        let elemButton = $('#check-erp-status');
        if(elemButton.hasClass('disabled')) return;

        elemButton.addClass('disabled').text('Checking...');
        setERPStatusOutput('Checking ERP status', {
            url: erpStatusProxyUrl,
            timestamp: new Date().toISOString()
        }, false);

        let requestSettings = {
            url         : erpStatusProxyUrl,
            method      : 'POST',
            contentType : 'application/json',
            data        : '{}'
        };

        $.ajax(requestSettings).done(function(response, textStatus, jqXHR) {
            let payload = (response && response.data && typeof response.data.body !== 'undefined')
                ? response.data.body
                : ((response && typeof response.body !== 'undefined') ? response.body : (response.data || response));

            setERPStatusOutput('ERP status check succeeded', payload, false);
        }).fail(function(jqXHR, textStatus, errorThrown) {
            let responseText = jqXHR.responseText || '';
            let payload = responseText;

            try {
                let parsed = JSON.parse(responseText);
                if(parsed && parsed.data && typeof parsed.data.body !== 'undefined') {
                    payload = parsed.data.body;
                } else if(parsed && parsed.data && typeof parsed.data.response !== 'undefined') {
                    payload = parsed.data.response;
                } else {
                    payload = parsed;
                }
            } catch(error) {
                payload = responseText;
            }

            setERPStatusOutput('ERP status check failed', payload || {
                httpStatus : jqXHR.status || null,
                statusText : textStatus,
                error      : errorThrown || ''
            }, true);
        }).always(function() {
            elemButton.removeClass('disabled').text('Check ERP Status');
        });
    }

    function resizeViewerIfStarted(delay) {
        if(typeof viewerResize === 'function') {
            viewerResize(delay);
            return;
        }

        if(typeof viewer === 'undefined' || !viewer || typeof viewer.resize !== 'function') return;

        setTimeout(function() {
            viewer.resize();
        }, typeof delay === 'number' ? delay : 250);
    }

    function leaveERPMode() {
        if(!$('body').hasClass('mode-erp')) return;

        $('body').removeClass('mode-erp');
        resizeViewerIfStarted(250);
    }

    function insertERPTab() {
        if($('#mode-erp').length) return;

        $('<div></div>')
            .attr('id', 'mode-erp')
            .addClass('panel-title-main')
            .attr('data-id', 'erp')
            .text('Impuls')
            .insertAfter('#mode-operations');

        let elemERP = $('<div></div>')
            .addClass('panel-content')
            .addClass('tab-group-main')
            .attr('id', 'erp')
            .hide();

        let elemPanel = $('<div></div>')
            .appendTo(elemERP)
            .addClass('surface-level-2')
            .addClass('erp-panel');

        $('<div></div>')
            .appendTo(elemPanel)
            .addClass('erp-title')
            .text('ERP Integration');

        $('<div></div>')
            .appendTo(elemPanel)
            .addClass('erp-description')
            .text('Check connectivity and response from the ERP endpoint.');

        $('<div></div>')
            .appendTo(elemPanel)
            .attr('id', 'toggle-erp-technology-test-run')
            .addClass('button')
            .addClass('with-icon')
            .addClass('icon-toggle-on')
            .addClass('filled')
            .text('Test Run Only')
            .click(function() {
                $(this)
                    .toggleClass('filled')
                    .toggleClass('icon-toggle-on')
                    .toggleClass('icon-toggle-off');
            });

        $('<div></div>')
            .appendTo(elemPanel)
            .attr('id', 'preview-erp-technologies')
            .addClass('button')
            .text('Preview Technology JSON')
            .click(previewERPTechnologies);

        $('<div></div>')
            .appendTo(elemPanel)
            .attr('id', 'sync-erp-technologies')
            .addClass('button')
            .addClass('default')
            .text('Sync Technology to ERP')
            .click(syncERPTechnologies);

        $('<div></div>')
            .appendTo(elemPanel)
            .attr('id', 'check-erp-status')
            .addClass('button')
            .text('Check ERP Status')
            .click(checkERPStatus);

        $('<div></div>')
            .appendTo(elemPanel)
            .attr('id', 'copy-erp-status')
            .addClass('button')
            .text('Copy Response')
            .click(copyERPStatusOutput);

        $('<div></div>')
            .appendTo(elemPanel)
            .attr('id', 'erp-status-output')
            .addClass('erp-status-output')
            .html('<pre>ERP status output will appear here.</pre>');

        $('#tabs').append(elemERP);
    }

    function attachERPTabEvents() {
        if($('#mode-erp').length === 0) return;

        $('#mode-erp').off('click.custom-erp').on('click.custom-erp', function() {
            $('body')
                .removeClass('mode-disassemble')
                .removeClass('mode-ebom')
                .removeClass('mode-add')
                .removeClass('mode-operations')
                .addClass('mode-erp');

            $(this).addClass('selected');
            $(this).siblings().removeClass('selected');
        });

        $('#mode-disassemble, #mode-ebom, #mode-add, #mode-operations')
            .off('click.custom-erp-leave')
            .on('click.custom-erp-leave', function() {
                leaveERPMode();
            });
    }

    function attachCustomModeResizeEvents() {
        $('#mode-add')
            .off('click.custom-mode-resize')
            .on('click.custom-mode-resize', function() {
                leaveERPMode();
                resizeViewerIfStarted(250);
            });

        $('#mode-operations')
            .off('click.custom-mode-resize')
            .on('click.custom-mode-resize', function() {
                leaveERPMode();
                resizeViewerIfStarted(250);
            });

        $('#toggle-viewer')
            .off('click.custom-toggle-viewer')
            .on('click.custom-toggle-viewer', function() {
                resizeViewerIfStarted(100);
            });
    }

    function insertAddRawMaterialsButton() {
        if($('#add-raw-materials').length) return;

        let button = $('<div></div>')
            .attr('id', 'add-raw-materials')
            .addClass('button default')
            .attr('title', 'Add raw materials found by EBOM MATERIAL values')
            .html('Dodaj Surowce')
            .click(addRawMaterialsFromEBOM);

        if($('#header-toolbar').length) {
            $('#header-toolbar').find('#header-avatar').before(button);
        } else {
            $('body').append(button);
        }
    }

    function isEBOMMakeItem(node, elemNode) {
        let makeBuyValues = [];

        if(node && typeof node.makeBuy === 'string') {
            makeBuyValues.push(node.makeBuy);
        } else if(node && node.makeBuy) {
            makeBuyValues.push(node.makeBuy.title);
            makeBuyValues.push(node.makeBuy.name);
            makeBuyValues.push(node.makeBuy.value);
        }

        if(elemNode && elemNode.length > 0) {
            let elemMakeBuy = elemNode.children('.item-head').children('.item-make-buy').first();
            if(elemMakeBuy.length > 0) {
                makeBuyValues.push(elemMakeBuy.children('option:selected').text());
            }
        }

        return makeBuyValues.some(function(value) {
            return normalizeComparisonValue(value) === 'make';
        });
    }

    function addEBOMMakeFactoryAction(elemNode, node) {
        if(!elemNode || elemNode.length === 0 || !node) return;
        if(Number(node.level) === 0 || !elemNode.hasClass('leaf')) return;
        if(!isEBOMMakeItem(node, elemNode)) return;

        let linkedMBOM = elemNode.attr('data-mbom') || ((node.mbom && node.mbom.link) ? node.mbom.link : '');
        if(!isBlank(linkedMBOM)) return;

        let elemActions = elemNode.children('.item-head').children('.item-actions').first();
        if(elemActions.length === 0 || elemActions.children('.item-action-make-factory').length > 0) return;

        elemNode.addClass('ebom-make-item');

        addActionIcon('factory', elemActions)
            .addClass('item-action-convert')
            .addClass('item-action-make-factory')
            .attr('title', 'Create a linked MBOM and add it to the selected MBOM node')
            .click(function(e) {
                e.stopPropagation();
                e.preventDefault();

                $('#ebom').find('.item.to-convert').removeClass('to-convert');

                let elemItem = $(this).closest('.item');
                elemItem.addClass('to-convert');

                let itemName = elemItem.find('.item-head-descriptor').first().html();
                $('#convert-item-name').html(itemName);
                $('#dialog-convert').show();
                $('#overlay').show();
            });
    }

    $(document).ready(function() {
        insertAddRawMaterialsButton();
        insertAddAssemblyIndexButton();
        setupAddProcessPicker();
        insertERPTab();
        attachERPTabEvents();
        attachCustomModeResizeEvents();
    });

    if(typeof setStatusBar === 'function') {
        let originalSetStatusBar = setStatusBar;

        setStatusBar = function() {
            let restoredEBOMLinks = [];

            // The standard comparison uses EBOM data-link directly. For a
            // linked sub-MBOM, data-link is the EBOM item while data-mbom is
            // the item that actually exists in the manufacturing structure.
            $('#ebom').find('.item[data-mbom]').each(function() {
                let elemEBOMItem = $(this);
                let mappedMBOMLink = elemEBOMItem.attr('data-mbom') || '';
                let normalizedMappedLink = normalizePLMLink(mappedMBOMLink);
                if(isBlank(normalizedMappedLink)) return;

                let comparisonLink = mappedMBOMLink;

                $('#mbom').find('.item.is-ebom-item').each(function() {
                    let elemMBOMItem = $(this);
                    let mbomLink = elemMBOMItem.attr('data-link') || '';
                    let linkedMBOM = elemMBOMItem.attr('data-link-mbom') || '';

                    if(normalizePLMLink(mbomLink) === normalizedMappedLink ||
                        normalizePLMLink(linkedMBOM) === normalizedMappedLink) {
                        comparisonLink = mbomLink || linkedMBOM || mappedMBOMLink;
                        return false;
                    }
                });

                restoredEBOMLinks.push({
                    elem : elemEBOMItem,
                    link : elemEBOMItem.attr('data-link')
                });
                elemEBOMItem.attr('data-link', comparisonLink);
            });

            try {
                return originalSetStatusBar.apply(this, arguments);
            } finally {
                restoredEBOMLinks.forEach(function(state) {
                    state.elem.attr('data-link', state.link);
                });
            }
        };
    }

    if(typeof isMBOMLeaf === 'function') {
        isMBOMLeaf = function(node) {
            if(node.level === 0) return false;
            if(isAssemblyIndexNode(node)) return false;
            if(node.endItem) return true;
            if(node.matchesMBOM) return true;
            if(!(isBlank(node.ebom))) return true;
            if(node.isProcess) return false;

            return !node.hasChildren;
        };
    }

    if(typeof getBOMPartHasChildren === 'function') {
        getBOMPartHasChildren = function(node, bomPartsList) {
            return getBOMPartHasChildrenCustom(node, bomPartsList);
        };
    }

    if(typeof addMBOMShortcut === 'function') {
        addMBOMShortcut = function(elemParent) {
            elemParent.addClass('has-mbom-shortcuts');

            $('<div></div>').appendTo(elemParent)
                .addClass('icon')
                .addClass('mbom-shortcut')
                .addClass('icon-open')
                .attr('title', 'Open the linked MBOM in a new tab')
                .click(function(e) {

                    e.preventDefault();
                    e.stopPropagation();

                    let elemItem = $(this).closest('.item');
                    openMBOMEditorFromItem(elemItem);

                });

            $('<div></div>').appendTo(elemParent)
                .addClass('icon')
                .addClass('mbom-shortcut')
                .addClass('icon-factory')
                .attr('title', 'Expand or collapse the linked sub-MBOM inline')
                .click(function(e) {

                    e.preventDefault();
                    e.stopPropagation();

                    let elemItem = $(this).closest('.item');
                    expandInlineSubMBOMForElement(elemItem);

                });
        };
    }

    if(typeof insertBOMPartListNode === 'function') {
        let originalInsertBOMPartListNode = insertBOMPartListNode;
        insertBOMPartListNode = function(bomType, index, node) {
            let resolvedNode = node;
            if(isBlank(resolvedNode)) {
                resolvedNode = (bomType === 'ebom') ? ebomPartsList[index] : mbomPartsList[index];
            }

            if(bomType === 'mbom' && resolvedNode) {
                resolvedNode.isAssemblyIndex = isAssemblyIndexNode(resolvedNode);
                if(resolvedNode.isAssemblyIndex) {
                    resolvedNode.hasChildren = true;
                    resolvedNode.isLeaf = false;
                    resolvedNode.icon = 'radio-process';
                }

                if(isBlank(resolvedNode.unitOfMeasure)) {
                    resolvedNode.unitOfMeasure = getMBOMPartUnitOfMeasure(resolvedNode);
                }
            }

            let elemNode = originalInsertBOMPartListNode.call(this, bomType, index, resolvedNode);

            if(bomType === 'ebom') {
                addEBOMMakeFactoryAction(elemNode, resolvedNode);
            }

            if(bomType === 'mbom' && resolvedNode && resolvedNode.isAssemblyIndex) {
                elemNode
                    .removeClass('leaf')
                    .addClass('item-has-bom assembly-index')
                    .attr('data-link-mbom', resolvedNode.link || elemNode.attr('data-link'));

                elemNode.children('.item-head').children('.item-icon').first()
                    .removeClass('icon-wrench')
                    .addClass('radio-process')
                    .attr('title', 'Indeks montażowy/złożeniowy');

                ensureMBOMShortcutIcons(elemNode);
            }

            decorateMBOMQuantityWithUnit(elemNode, resolvedNode, bomType);
            return elemNode;
        };
    }

    if(typeof insertAdditionalItem === 'function') {
        insertAdditionalItem = function(elemHead, link) {
            console.log('MBOM custom: insertAdditionalItem started', {
                link : link
            });

            $('#overlay').show();

            let requests = [
                $.get('/plm/details', { link : link } ),
                $.get('/plm/bom', {
                    link         : link,
                    viewId       : wsMBOM.viewId,
                    depth        : getCustomMBOMDepth(),
                    revisionBias : config.revisionBias
                })
            ];

            return Promise.all(requests).then(function(responses) {

                let isProcess = getSectionFieldValue(responses[0].data.sections, config.workspaceMBOM.fieldIDs.isProcess, false);
                let insertedNode = $();

                $('#overlay').hide();

                if(isProcess == 'true') {

                    mBOM = responses[1].data;
                    for(let edgeMBOM of mBOM.edges) edgeMBOM.depth++;
                    let newNode = setMBOM(elemHead.next(), mBOM.root, 2, null, '', true);
                    insertedNode = newNode;
                    matchEBOMItems(newNode);

                } else {

                    let elemParent = elemHead.next();

                    let node = {
                        link       : link,
                        root       : responses[0].data.root.link,
                        revision   : (responses[0].data.workingVersion) ? 'W' : responses[0].data.versionId,
                        title      : responses[0].data.title,
                        bomType    : 'mbom',
                        quantity   : 1,
                        partNumber : getSectionFieldValue(responses[0].data.sections, config.workspaceMBOM.fieldIDs.number   , ''),
                        type       : getSectionFieldValue(responses[0].data.sections, config.workspaceMBOM.fieldIDs.type     , '', 'title'),
                        category   : getSectionFieldValue(responses[0].data.sections, config.workspaceMBOM.fieldIDs.category , ''),
                        code       : getSectionFieldValue(responses[0].data.sections, config.workspaceMBOM.fieldIDs.code     , ''),
                        unitOfMeasure : getItemDetailsUnitOfMeasure(responses[0].data.sections),
                        xbom       : getSectionFieldValue(responses[0].data.sections, config.workspaceMBOM.fieldIDs.ebom     , ''),
                        makeBuy    : getSectionFieldValue(responses[0].data.sections, config.workspaceEBOM.fieldIDs.makeOrBuy, '', 'object'),
                        isEBOMItem : false,
                        isProcess  : false,
                        isLeaf     : true
                    };

                    $('#ebom').find('.item').each(function() { if($(this).attr('data-root') === node.root) node.isEBOMItem = true; });

                    node.icon = getBOMPartIcon(node);

                    insertedNode = insertBOMPartListNode('mbom', null, node).appendTo(elemParent);
                }

                updateMBOMNumbers();

                console.log('MBOM custom: insertAdditionalItem finished', {
                    link          : link,
                    isProcess     : isProcess == 'true',
                    insertedItems : insertedNode.length
                });
                return insertedNode;
            }).catch(function(error) {
                $('#overlay').hide();
                console.warn('MBOM custom: insertAdditionalItem failed', {
                    link  : link,
                    error : error
                });
                throw error;
            });

        };
    }

    if(typeof insertNewProcess === 'function') {
        insertNewProcess = function() {
            return insertSelectedWorkspaceProcess();
        };
    }

    if(typeof addBOMItems === 'function') {
        addBOMItems = function() {
            let pending  = $('.pending-addition').length;
            let progress = (pendingActions[2] - pending) * 100 / pendingActions[2];

            console.log('MBOM custom: addBOMItems batch state', {
                pending    : pending,
                maxRequests: maxRequests
            });

            $('#step-bar3').css('width', progress + '%');
            $('#step-counter3').html((pendingActions[2] - pending) + ' of ' + pendingActions[2]);

            if(pending > 0) {

                let requests = [];
                let elements = [];

                $('.pending-addition').each(function() {

                    if(requests.length < maxRequests) {
                    
                        let elemItem     = $(this);
                        let elemParent   = elemItem.parent().closest('.item');
                        let edQty        = elemItem.find('.item-qty-input').first().val();
                        let makeBuy      = elemItem.find('.item-make-buy').first().val();
                        let linkMBOM     = elemItem.attr('data-link-mbom');
                        let isEBOMItem   = elemItem.hasClass('is-ebom-item');
                        let linkParent   = getMBOMSaveLink(elemParent);
                        
                        let params = {                    
                            linkParent : linkParent,
                            linkChild  : (typeof linkMBOM !== 'undefined') ? linkMBOM : elemItem.attr('data-link'),
                            number     : elemItem.attr('data-number'),
                            pinned     : (isEBOMItem && config.pinEBOMItemsInMBOM),
                            quantity   : edQty,
                            fields     : []
                        };

                        if(!isBlank(bomViewLinksMBOM.isEBOMItem)) {
                            params.fields.push({ link : bomViewLinksMBOM.isEBOMItem, value : isEBOMItem });
                        }

                        if(isBlank(linkParent)) {
                            console.warn('MBOM custom: missing MBOM parent link while saving added item', elemItem.attr('data-link'));
                            return;
                        }

                        console.log('MBOM custom: saving pending raw/additional item', {
                            parentLink : linkParent,
                            childLink  : params.linkChild,
                            quantity   : edQty,
                            number     : params.number
                        });

                        if(!isBlank(makeBuy) && !isBlank(bomViewLinksMBOM.makeBuy)) {
                            params.fields.push({ link : bomViewLinksMBOM.makeBuy, value : { link : makeBuy } });
                        }

                        requests.push($.post('/plm/bom-add', params));
                        elemItem.attr('data-make-buy', makeBuy);
                        elements.push(elemItem);

                    }

                });

                Promise.all(requests).then(function(responses) {
                    console.log('MBOM custom: addBOMItems save batch completed', {
                        requests : responses.length
                    });
                
                    requests = [];

                    for(let response of responses) {
                        if(response.error) {
                            showErrorMessage('Error while adding BOM items', response.message);
                            endProcessing();
                            return;
                        } else {
                            requests.push($.get('/plm/bom-item', { 'link' : response.data }));
                        }
                    }

                    Promise.all(requests).then(function(responses) {

                        let index = 0;

                        for(let response of responses) {

                            let elemItem   = elements[index++];
                            let elemParent = elemItem.parent().closest('.item');
                            let edgeId     = response.data.__self__.split('/')[8];
                            let itemNumber = response.data.itemNumber;

                            elemItem.removeClass('pending-addition');
                            elemItem.attr('data-number-db', itemNumber);
                            elemItem.attr('data-edge', edgeId);

                            if((typeof elemParent.attr('data-edges') === 'undefined') || (elemParent.attr('data-edges') === '')) {
                                elemParent.attr('data-edges', edgeId);
                            } else {
                                let edges = elemParent.attr('data-edges').split(',');
                                edges.push(edgeId);
                                elemParent.attr('data-edges', edges.toString());
                            }

                        }

                        addBOMItems();

                    });
                
                });

            } else {

                $('#step-bar3').css('width', '100%');
                $('#step3').removeClass('in-work');
                $('#step4').addClass('in-work');
                $('#step-counter3').html(pendingActions[2] + ' of ' + pendingActions[2]);

                updateBOMItems();
            }
        };
    }

    if(typeof updateBOMItems === 'function') {
        updateBOMItems = function() {
            let pending  = $('.pending-update').length;
            let progress = (pendingActions[3] - pending) * 100 / pendingActions[3];

            console.log('MBOM custom: updateBOMItems batch state', {
                pending    : pending,
                maxRequests: maxRequests
            });

            $('#step-bar4').css('width', progress + '%');
            $('#step-counter4').html((pendingActions[3] - pending) + ' of ' + pendingActions[3]);

            if(pending > 0) {

                let requests = [];
                let elements = [];

                $('.pending-update').each(function() {

                    if(requests.length < maxRequests) {

                        let elemItem     = $(this);
                        let elemParent   = elemItem.parent().closest('.item');
                        let paramsChild  = elemItem.attr('data-link').split('/');
                        let urnMBOM      = elemItem.attr('data-link-mbom');
                        let edQty        = elemItem.find('.item-qty-input').first().val();
                        let edMakeBuy    = elemItem.find('.item-make-buy').first().val();
                        let isEBOMItem   = elemItem.hasClass('is-ebom-item');
                        let linkParent   = getMBOMSaveLink(elemParent);

                        if(typeof urnMBOM !== 'undefined') {
                            let data = elemItem.attr('data-link-mbom').split('.');
                            paramsChild[4] = data[4];
                            paramsChild[6] = data[5];
                        }

                        let params = { 
                            linkParent : linkParent,
                            wsIdChild  : paramsChild[4],
                            dmsIdChild : paramsChild[6],
                            edgeId     : elemItem.attr('data-edge'),
                            number     : elemItem.attr('data-number'),
                            pinned     : (isEBOMItem && config.pinEBOMItemsInMBOM),
                            quantity   : edQty,
                            fields     : [],                    
                        };

                        if(isBlank(linkParent)) {
                            console.warn('MBOM custom: missing MBOM parent link while updating item', elemItem.attr('data-link'));
                            return;
                        }

                        if(config.displayOptions.bomColumnMakeBuy) {
                            params.fields.push({ link : bomViewLinksMBOM.makeBuy , value : { link : edMakeBuy} });
                        }

                        requests.push($.post('/plm/bom-update', params));
                        elements.push(elemItem);

                    }

                });

                Promise.all(requests).then(function(responses) {

                    let index = 0;

                    for(let response of responses) {

                        let elemItem = elements[index++];
                            elemItem.removeClass('pending-update');
                            elemItem.attr('data-number-db', response.params.number);
                            elemItem.attr('data-qty', response.params.quantity);
                            
                        if(config.displayOptions.bomColumnMakeBuy) {                    
                            elemItem.attr('data-make-buy', response.params.fields[0].value.link);
                        }
                
                    }

                    updateBOMItems();

                });

            } else {

                $('#step-bar4').css('width', '100%');
                $('#step4').removeClass('in-work');
                $('#step-counter4').html(pendingActions[3] + ' of ' + pendingActions[3]);

                endProcessing();

            }
        };
    }

    if(typeof initEditor === 'function') {
        let originalInitEditor = initEditor;
        initEditor = function() {
            refreshMBOMHierarchyFlags();
            originalInitEditor.apply(this, arguments);
            insertAddAssemblyIndexButton();
            setupAddProcessPicker();
            $('#confirm-raw-materials').off('click').on('click', function() {
                if($(this).hasClass('disabled')) return;
                $('#overlay').hide();
                $('#dialog-raw-materials').hide();
            });
            attachCustomSaveGuard();
            attachERPTabEvents();
            attachCustomModeResizeEvents();
            // findTitleMatchesForMaterials();
        };
    } else {
        console.warn('MBOM custom: initEditor is not defined yet; MATERIAL match search was not attached.');
    }

    if(typeof createMBOMForEBOM === 'function') {
        createMBOMForEBOM = function(ebomItemDetails, number, callback) {

            let timestamp = new Date();
            let syncDate  = timestamp.getFullYear() + '-' + (timestamp.getMonth() + 1) + '-' + timestamp.getDate();

            let params = {
                wsId     : wsMBOM.wsId,
                sections : wsMBOM.sections,
                fields   : [{
                    fieldId : config.workspaceMBOM.fieldIDs.ebom,
                    value   : { link : ebomItemDetails.__self__ }
                },{
                    fieldId : config.workspaceMBOM.fieldIDs.ebomRoot,
                    value   : ebomItemDetails.root.link
                },{
                    fieldId : config.workspaceMBOM.fieldIDs.lastMBOMSync,
                    value   : syncDate
                },{
                    fieldId : config.workspaceMBOM.fieldIDs.lastMBOMUser,
                    value   : userAccount.displayName
                }]
            };

            for(let fieldToCopy of config.mbomRoot.fieldsToCopy) {
                params.fields.push({
                    fieldId : fieldToCopy.mbom,
                    value   : getSectionFieldValue(ebomItemDetails.sections, fieldToCopy.ebom)
                });
            }

            if(Array.isArray(config.mbomRoot.defaultValues)) {
                for(let defaultValue of config.mbomRoot.defaultValues) {
                    params.fields.push({ fieldId : defaultValue[0], value : defaultValue[1] });
                }
            }

            if(!isBlank(config.mbomRoot.typeValue)) {
                params.fields.push({
                    fieldId : config.workspaceMBOM.fieldIDs.type,
                    value   : { link : config.mbomRoot.typeValue }
                });
            }

            if(!isBlank(number)) {
                params.fields.push({
                    fieldId : config.workspaceMBOM.fieldIDs.number,
                    value   : number
                });
            }

            $.post({
                url         : '/plm/create',
                contentType : 'application/json',
                data        : JSON.stringify(params)
            }, function(response) {
                printResponseErrorMessagesToConsole(response);
                if(response.error) {
                    showErrorMessage('Error', 'Error while creating MBOM root item, the editor cannot be used at this time. Please review your server configuration.');
                } else {
                    let createdLink = (response.data && response.data.__self__)
                        ? response.data.__self__
                        : response.data;

                    if(typeof createdLink === 'string') {
                        createdLink = createdLink.replace(/^https?:\/\/[^/]+/i, '');
                    }

                    if(isBlank(createdLink)) {
                        console.error('MBOM custom: create response did not contain an MBOM link', response);
                        showErrorMessage('Error', 'The MBOM root was created, but its link was missing from the server response.');
                        return;
                    }

                    links.mbom = createdLink;
                    storeMBOMLink(ebomItemDetails.__self__);
                    storeContextMBOMLink();
                    if(typeof callback === 'function') callback(links.mbom);
                }
            });

        };
    }

    if(typeof window !== 'undefined') {
        window.findMBOMMaterialTitleMatches = findTitleMatchesForMaterials;
    }

})();
