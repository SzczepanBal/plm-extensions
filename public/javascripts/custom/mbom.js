(function() {

    const rawMaterialsWorkspaceId = 57;
    const addProcessWorkspaceId = 274;
    const addProcessWorkspacePageSize = 250;
    const rawMaterialFallbackProcessName = 'Ciecie';
    const rawMaterialAccountingUnitFieldId = 'JEDNOSTKA_ROZLICZENIOWA';
    const rawMaterialAccountingQuantityFieldId = 'ILOSC_ROZLICZENIOWA';
    const rawMaterialProductGroupFieldId = 'GRUPA_PRODUKTOWA_SUROWCOW';
    const rawMaterialsBOMViewName = 'Raw Materials';
    const rawMaterialTypeName = 'Surowiec';
    const rawMaterialTypeQueryValue = 'SUROWIEC';
    const rawMaterialApplyModes = {
        addMissing     : 'add-missing',
        updateQuantity : 'update-quantity',
        overwrite      : 'overwrite'
    };
    let rawMaterialsBOMViewPromise = null;
    const erpTechnologyDiscoveryDepth = 2;
    const erpStatusProxyUrl = '/plm/custom-erp-status';
    const assemblyIndexPLMDefaults = {
        productGroup : 'PCP',
        partType     : 'Z',
        kind         : 'Z',
        variant      : 'Standard',
        specification: 'Złożenie',
        moc: 'Test',
        nazwa_urzadzenia: 'Test'
    };
    let addProcessWorkspaceItemsPromise = null;
    let addProcessWorkspaceItemsCache = [];
    let rawMaterialTargetSequence = 0;
    let rawMaterialSearchPromises = {};
    let rawMaterialCreationPromises = {};
    let rawMaterialDetailsPromises = {};
    let rawMaterialItemDetailsPromises = {};
    let rawMaterialStructureDirty = false;
    let rawMaterialStructureRefreshPromise = null;
    let rawMaterialStructuralSavePending = false;
    let inlineSubMBOMBulkExpansionActive = false;
    let holisticMBOMRequests = {};
    let holisticStatusTimer = null;
    let holisticStatusRun = 0;
    let directAssemblyIndexEditor = false;
    let mbomOperationTypeValue = '';
    let mbomOperationTypePromise = null;
    let erpTechnologyPLMActiveRequests = 0;
    let erpTechnologyPLMRequestQueue = [];

    function normalizeComparisonValue(value) {
        if(value === null || typeof value === 'undefined') return '';
        return value.toString().trim().replace(/\s+/g, ' ').toLowerCase();
    }

    function mapPLMRequestsWithConcurrency(items, concurrency, mapper) {
        let sourceItems = Array.isArray(items) ? items : [];
        let results = new Array(sourceItems.length);
        let nextIndex = 0;
        let workerCount = Math.min(Math.max(1, Number(concurrency) || 1), sourceItems.length);
        let workers = [];

        async function processNext() {
            while(nextIndex < sourceItems.length) {
                let index = nextIndex++;
                results[index] = await mapper(sourceItems[index], index);
            }
        }

        for(let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
            workers.push(processNext());
        }

        return Promise.all(workers).then(function() { return results; });
    }

    function runERPTechnologyPLMRequest(requestFactory) {
        return new Promise(function(resolve, reject) {
            erpTechnologyPLMRequestQueue.push({
                requestFactory: requestFactory,
                resolve       : resolve,
                reject        : reject
            });

            function startQueuedRequests() {
                while(erpTechnologyPLMActiveRequests < 6 && erpTechnologyPLMRequestQueue.length > 0) {
                    let queued = erpTechnologyPLMRequestQueue.shift();
                    erpTechnologyPLMActiveRequests++;

                    Promise.resolve().then(queued.requestFactory).then(function(result) {
                        erpTechnologyPLMActiveRequests--;
                        queued.resolve(result);
                        startQueuedRequests();
                    }, function(error) {
                        erpTechnologyPLMActiveRequests--;
                        queued.reject(error);
                        startQueuedRequests();
                    });
                }
            }

            startQueuedRequests();
        });
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

    function getMBOMAccountingFieldValue(part, fieldId) {
        if(!part) return '';

        if(part.details && Object.prototype.hasOwnProperty.call(part.details, fieldId)) {
            return part.details[fieldId];
        }

        if(Array.isArray(part.fields)) {
            let value = getBOMPartFieldValue(part, fieldId);
            if(value !== null && typeof value !== 'undefined') return value;
        }

        return '';
    }

    function getMBOMAccountingUnit(part) {
        return normalizeMBOMUnitOfMeasureValue(
            getMBOMAccountingFieldValue(part, rawMaterialAccountingUnitFieldId)
        );
    }

    function getMBOMAccountingQuantity(part) {
        return parseNumericValue(
            getMBOMAccountingFieldValue(part, rawMaterialAccountingQuantityFieldId)
        );
    }

    function getMBOMAccountingUnitFromItemDetails(itemDetails) {
        if(!itemDetails || !itemDetails.sections) return '';
        return normalizeMBOMUnitOfMeasureValue(
            getSectionFieldValue(itemDetails.sections, rawMaterialAccountingUnitFieldId, '', 'object')
        );
    }

    function getMBOMAccountingQuantityFromItemDetails(itemDetails) {
        if(!itemDetails || !itemDetails.sections) return NaN;
        return parseNumericValue(
            getSectionFieldValue(itemDetails.sections, rawMaterialAccountingQuantityFieldId, '', null)
        );
    }

    function isMBOMHasBOM(value) {
        return value === true || value === 1 || (typeof value === 'string' && /^(true|1)$/i.test(value.trim()));
    }

    async function getSourceEBOMHasChildren(ebomItemDetails) {
        let response = await $.get('/plm/bom', {
            link: ebomItemDetails.__self__, viewId: wsEBOM.viewId,
            depth: 1, revisionBias: 'working', getBOMPartsList: true
        });
        if(!response || response.error || !response.data || !Array.isArray(response.data.bomPartsList)) {
            throw new Error('Could not check source EBOM children. ' + getRawMaterialErrorMessage(response));
        }
        return response.data.bomPartsList.some(function(part) { return Number(part.level) === 1; });
    }

    function getRawMaterialSkipReason(entry) {
        if(entry.detailsError) return 'Nie udało się odczytać szczegółów mBOM; nie można sprawdzić pola HAS_BOM.';
        if(entry.hasBom) return 'Pominięto: pole HAS_BOM ma wartość true (źródłowy eBOM ma elementy podrzędne).';
        return '';
    }

    function fetchMBOMPartMaterialsFromDetails(mbomParts) {
        let requests = mbomParts.map(function(part) {
            let link = getPartItemLink(part);
            if(!link) {
                return Promise.resolve({
                    part               : part,
                    detailsError       : true,
                    material           : '',
                    accountingUnit     : '',
                    accountingQuantity : NaN,
                    productGroup       : ''
                });
            }

            let cacheKey = normalizePLMLink(link);
            if(!rawMaterialDetailsPromises[cacheKey]) {
                rawMaterialDetailsPromises[cacheKey] = new Promise(function(resolve) {
                    $.get('/plm/details', { link: link })
                    .done(function(response) {
                        if(!response || response.error || !response.data) {
                            delete rawMaterialDetailsPromises[cacheKey];
                            resolve({ detailsError: true });
                            return;
                        }
                        let hasBom = isMBOMHasBOM(getSectionFieldValue(response.data.sections, 'HAS_BOM', false));
                        let material = getMaterialValueFromItemDetails(response.data);
                        let accountingUnit = getMBOMAccountingUnitFromItemDetails(response.data);
                        let accountingQuantity = getMBOMAccountingQuantityFromItemDetails(response.data);
                        let productGroup = getSectionFieldValue(response.data.sections, rawMaterialProductGroupFieldId, '', null);
                        console.log('MBOM custom: fetched MBOM fallback details for raw material resolution', {
                            mbomLink           : link,
                            partNumber         : getPartNumber(part),
                            material           : material,
                            accountingUnit     : accountingUnit,
                            accountingQuantity : accountingQuantity,
                            productGroup       : productGroup
                        });
                        resolve({
                            hasBom             : hasBom,
                            material           : material,
                            accountingUnit     : accountingUnit,
                            accountingQuantity : accountingQuantity,
                            productGroup       : productGroup
                        });
                    })
                    .fail(function() {
                        delete rawMaterialDetailsPromises[cacheKey];
                        console.warn('MBOM custom: failed to fetch MBOM fallback details for raw material resolution', {
                            mbomLink   : link,
                            partNumber : getPartNumber(part)
                        });
                        resolve({
                            detailsError       : true,
                            material           : '',
                            accountingUnit     : '',
                            accountingQuantity : NaN,
                            productGroup       : ''
                        });
                    });
                });
            }

            return rawMaterialDetailsPromises[cacheKey].then(function(result) {
                return Object.assign({ part: part }, result);
            });
        });

        return Promise.all(requests);
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
            elemItem.children('.item-head').find('.mbom-shortcut.inline-submbom-toggle').length > 0;
    }

    function getLinkedMBOMLinkFromEBOMElement(elemItem) {
        if(!elemItem || elemItem.length === 0) return '';
        return elemItem.attr('data-mbom') ||
            elemItem.attr('data-link-mbom') ||
            elemItem.attr('data-linked-mbom') ||
            '';
    }

    function findRenderedMBOMItemByLink(link) {
        let normalizedLink = normalizePLMLink(link);
        let elemMatch = $();
        if(isBlank(normalizedLink)) return elemMatch;

        $('#mbom').find('.item').each(function() {
            let elemCandidate = $(this);
            let candidateLinks = [
                elemCandidate.attr('data-link'),
                elemCandidate.attr('data-link-mbom'),
                elemCandidate.attr('data-linked-mbom')
            ];

            if(candidateLinks.some(function(candidateLink) {
                return normalizePLMLink(candidateLink) === normalizedLink;
            })) {
                elemMatch = elemCandidate;
                return false;
            }
        });

        return elemMatch;
    }

    function getStandardMBOMStatus(elemItem) {
        if(!elemItem || elemItem.length === 0) return '';
        if(elemItem.hasClass('additional')) return 'additional';
        if(elemItem.hasClass('different')) return 'different';
        if(elemItem.hasClass('match')) return 'match';
        return '';
    }

    function setLinkedEBOMBOMCheckPending(elemEBOMItem, pending) {
        if(!elemEBOMItem || elemEBOMItem.length === 0) return;

        let isEBOMBOM = elemEBOMItem.closest('#ebom').length > 0 &&
            !elemEBOMItem.hasClass('root') &&
            (
                elemEBOMItem.hasClass('item-has-bom') ||
                elemEBOMItem.children('.item-bom').children('.item').length > 0
            );
        let elemStatus = elemEBOMItem.children('.item-head').children('.item-head-status').first();

        if(!isEBOMBOM) {
            elemEBOMItem
                .removeClass('linked-mbom-bom')
                .removeClass('linked-mbom-check-pending')
                .removeAttr('data-linked-mbom-status-checked');
            return;
        }

        // Keep linked-assembly navigation and status separate from presence in
        // the current parent. Existing linked MBOMs can still be added there.
        elemEBOMItem.addClass('linked-mbom-bom');
        elemEBOMItem.toggleClass('linked-mbom-check-pending', pending === true);
        if(pending === true) elemEBOMItem.removeAttr('data-linked-mbom-status-checked');
        else elemEBOMItem.attr('data-linked-mbom-status-checked', 'true');
        if(elemStatus.length === 0) return;

        elemStatus.attr('title', pending === true
            ? 'Light gray: linked mBOM has not been loaded and checked yet'
            : 'EBOM / MBOM match indicator\r\n- Green : match\r\n- Red : missing in MBOM\r\n- Orange : quantity mismatch');
    }

    function completeLinkedEBOMBOMCheckForMBOM(elemMBOMItem) {
        if(!elemMBOMItem || elemMBOMItem.length === 0) return;

        let linkedMBOM = normalizePLMLink(
            elemMBOMItem.attr('data-link-mbom') ||
            elemMBOMItem.attr('data-linked-mbom') ||
            elemMBOMItem.attr('data-link') ||
            ''
        );
        if(isBlank(linkedMBOM)) return;

        $('#ebom').find('.item.linked-mbom-check-pending').each(function() {
            let elemEBOMItem = $(this);
            if(normalizePLMLink(getLinkedMBOMLinkFromEBOMElement(elemEBOMItem)) === linkedMBOM) {
                setLinkedEBOMBOMCheckPending(elemEBOMItem, false);
            }
        });
    }

    function mirrorStandardStatusToLinkedEBOMRows() {
        $('#ebom').find('.item').has('.linked-mbom-marker').each(function() {
            let elemEBOMItem = $(this);
            let linkedMBOM = getLinkedMBOMLinkFromEBOMElement(elemEBOMItem);
            let elemMBOMItem = findRenderedMBOMItemByLink(linkedMBOM);
            let state = getStandardMBOMStatus(elemMBOMItem);

            // The standard selection logic also correlates rows by their eBOM
            // root. Use that same relationship when the linked mBOM row itself
            // is a structural parent and therefore has no status class.
            if(isBlank(state)) {
                let ebomRoot = normalizePLMLink(elemEBOMItem.attr('data-root'));
                let statesByPriority = { match : 1, different : 2, additional : 3 };
                let currentPriority = 0;

                $('#mbom').find('.item.is-ebom-item').each(function() {
                    let elemCandidate = $(this);
                    let candidateRoot = normalizePLMLink(
                        elemCandidate.attr('data-ebom-root') || elemCandidate.attr('data-root')
                    );

                    if(isBlank(ebomRoot) || candidateRoot !== ebomRoot) return;

                    let candidateState = getStandardMBOMStatus(elemCandidate);
                    let candidatePriority = statesByPriority[candidateState] || 0;
                    if(candidatePriority > currentPriority) {
                        state = candidateState;
                        currentPriority = candidatePriority;
                    }
                });
            }

            elemEBOMItem.removeClass('additional different match');
            if(!isBlank(state)) elemEBOMItem.addClass(state);
        });
    }

    function revealLinkedTreeItem(elemItem, panelSelector, focusClass) {
        if(!elemItem || elemItem.length === 0) return;

        elemItem.parents('.item-bom').each(function() {
            let elemBOM = $(this);
            elemBOM.removeClass('hidden');
            let elemParentItem = elemBOM.parent('.item');
            elemBOM.prev('.item-head').children('.item-toggle')
                .removeClass('icon-expand')
                .addClass('icon-collapse');
            setInlineSubMBOMToggleState(elemParentItem, true);
        });

        $(panelSelector).find('.' + focusClass).removeClass(focusClass);
        elemItem.addClass(focusClass);

        if(elemItem[0] && typeof elemItem[0].scrollIntoView === 'function') {
            elemItem[0].scrollIntoView({ behavior : 'smooth', block : 'center' });
        }
    }

    function revealLinkedMBOMItem(elemItem) {
        revealLinkedTreeItem(elemItem, '#mbom', 'linked-mbom-focus');
    }

    function revealLinkedEBOMItem(elemItem) {
        revealLinkedTreeItem(elemItem, '#ebom', 'linked-ebom-focus');
    }

    function focusLinkedMBOMFromEBOM(elemEBOMItem, elemMarker) {
        let linkedMBOM = getLinkedMBOMLinkFromEBOMElement(elemEBOMItem);
        let elemMBOMItem = findRenderedMBOMItemByLink(linkedMBOM);

        $('#ebom').find('.linked-mbom-marker.active').each(function() {
            setLinkedMBOMMarkerState($(this), 'linked');
        });
        setLinkedMBOMMarkerState(elemMarker, 'loading');

        if(elemMBOMItem.length === 0) {
            setLinkedMBOMMarkerState(elemMarker, 'error');
            showErrorMessage('Linked mBOM', 'The linked mBOM is not part of the current manufacturing structure.');
            return;
        }

        revealLinkedMBOMItem(elemMBOMItem);

        ensureInlineSubMBOMExpanded(elemMBOMItem).then(function(success) {
            if(success) {
                setLinkedEBOMBOMCheckPending(elemEBOMItem, false);
                completeLinkedEBOMBOMCheckForMBOM(elemMBOMItem);
                setLinkedMBOMMarkerState(elemMarker, 'active');
                revealLinkedMBOMItem(elemMBOMItem);
            } else {
                setLinkedMBOMMarkerState(elemMarker, 'error');
            }
        }).catch(function() {
            setLinkedMBOMMarkerState(elemMarker, 'error');
        });
    }

    function setLinkedMBOMMarkerState(elemMarker, state) {
        if(!elemMarker || elemMarker.length === 0) return;

        elemMarker
            .removeClass('active loading error icon-radio-checked icon-radio-unchecked icon-factory')
            .attr('data-state', state);

        if(state === 'active') {
            elemMarker
                .addClass('active icon-factory')
                .attr('title', 'Linked mBOM is focused or expanded');
        } else if(state === 'loading') {
            elemMarker
                .addClass('loading')
                .attr('title', 'Linked mBOM is loading');
        } else if(state === 'error') {
            elemMarker
                .addClass('error icon-factory')
                .attr('title', 'Linked mBOM exists, but could not be loaded');
        } else {
            elemMarker
                .addClass('icon-factory')
                .attr('title', 'Linked mBOM exists - click to focus it');
        }
    }

    function addLinkedMBOMInsertAction(elemItem) {
        if(!elemItem || elemItem.length === 0 || elemItem.hasClass('root')) return;
        if(isBlank(getLinkedMBOMLinkFromEBOMElement(elemItem))) return;
        let actions = elemItem.children('.item-head').children('.item-actions').first();
        if(actions.length === 0 || actions.children('.item-action-add-linked-mbom').length > 0) return;
        actions.children('.item-action-add').remove();
        addAction('Add MBOM', actions)
            .addClass('item-action-add item-action-add-linked-mbom')
            .attr('title', 'Add the existing linked MBOM to the selected operation')
            .click(function(e) {
                e.stopPropagation();
                e.preventDefault();
                insertFromEBOMToMBOM($(this));
                setStatusBar();
                setStatusBarFilter();
            });
    }

    function refreshMissingLinkedMBOMStatus() {
        $('#ebom').find('.item').each(function() {
            let elemItem = $(this);
            if(elemItem.hasClass('root')) return;
            let link = getLinkedMBOMLinkFromEBOMElement(elemItem);
            if(isBlank(link)) return;
            // Nested MBOM rows may be represented by their EBOM/root identity
            // before their linked MBOM URL is resolved. Use the full matcher.
            let missing = findLinkedMBOMItemForEBOM(elemItem).length === 0;
            elemItem.toggleClass('linked-mbom-missing', missing);
            if(missing) {
                addLinkedMBOMInsertAction(elemItem);
                setLinkedEBOMBOMCheckPending(elemItem, false);
                setHolisticItemState(elemItem, 'additional');
                elemItem.children('.item-head').children('.item-head-status')
                    .attr('title', 'Red: linked MBOM exists but is missing from the current manufacturing structure. Use Add MBOM.');
            } else {
                elemItem.children('.item-head').children('.item-actions')
                    .children('.item-action-add-linked-mbom').remove();
            }
        });
    }

    function insertLinkedMBOMWithoutEBOMChildren(elemAction, insert) {
        let elemItem = elemAction.closest('.item');
        let branch = elemItem.children('.item-bom').detach();
        let wasLeaf = elemItem.hasClass('leaf');
        // The existing insertion routine clones the source row and swaps its link to data-mbom.
        // Do not clone engineering children into the manufacturing structure.
        elemItem.addClass('leaf');
        try {
            return insert(elemAction);
        } finally {
            elemItem.toggleClass('leaf', wasLeaf);
            elemItem.append(branch);
        }
    }

    function addLinkedMBOMMarker(elemItem, linkedMBOM) {
        if(!elemItem || elemItem.length === 0 || isBlank(linkedMBOM)) return $();
        if(elemItem.hasClass('root')) return $();

        elemItem.attr('data-mbom', linkedMBOM);
        addLinkedMBOMInsertAction(elemItem);

        let elemHead = elemItem.children('.item-head').first();
        if(elemHead.length === 0) return $();

        let elemMarker = elemHead.children('.linked-mbom-marker').first();
        let isChecked = elemItem.attr('data-linked-mbom-status-checked') === 'true';
        setLinkedEBOMBOMCheckPending(elemItem, !isChecked);
        if(elemMarker.length > 0) return elemMarker;

        elemMarker = $('<div></div>')
            .addClass('icon')
            .addClass('linked-mbom-marker')
            .attr('role', 'button')
            .attr('tabindex', '0')
            .click(function(e) {
                e.stopPropagation();
                e.preventDefault();
                focusLinkedMBOMFromEBOM($(this).closest('.item'), $(this));
            })
            .keydown(function(e) {
                if(e.key !== 'Enter' && e.key !== ' ') return;
                e.stopPropagation();
                e.preventDefault();
                focusLinkedMBOMFromEBOM($(this).closest('.item'), $(this));
            });

        setLinkedMBOMMarkerState(elemMarker, 'linked');

        let elemActions = elemHead.children('.item-actions').first();
        if(elemActions.length > 0) elemMarker.insertBefore(elemActions);
        else elemMarker.appendTo(elemHead);

        return elemMarker;
    }

    function removeEBOMMBOMNavigationButtons(elemItem) {
        if(!elemItem || elemItem.length === 0) return;

        let elemHead = elemItem.children('.item-head').first();
        elemHead.children('.item-toggle').first()
            .removeClass('has-mbom-shortcuts')
            .children('.mbom-shortcut').remove();
    }

    function isMainMBOMRootItem(elemItem) {
        if(!elemItem || elemItem.length === 0) return false;

        let mainLink = (typeof links !== 'undefined' && links && links.mbom) ? links.mbom : '';
        let itemLink = elemItem.attr('data-link-mbom') || elemItem.attr('data-link') || '';

        if(!isBlank(mainLink) && !isBlank(itemLink)) {
            return normalizePLMLink(mainLink) === normalizePLMLink(itemLink);
        }

        return elemItem.closest('#mbom-tree').length > 0 && elemItem.parent().attr('id') === 'mbom-tree';
    }

    function isMBOMTechnologyItem(elemItem) {
        return isMainMBOMRootItem(elemItem) || hasMBOMShortcut(elemItem);
    }

    function ensureMBOMShortcutIcons(elemItem) {
        if(!elemItem || elemItem.length === 0) return;

        let elemToggle = elemItem.children('.item-head').children('.item-toggle').first();
        if(elemToggle.length === 0) return;

        if(elemToggle.children('.mbom-shortcut.inline-submbom-toggle').length === 0) {
            addMBOMShortcut(elemToggle);
        }

        // The collapse/expand pseudo-icon becomes a third grid item and hides
        // the open-in-new-tab shortcut. The inline shortcut handles toggling.
        elemToggle.removeClass('icon-collapse icon-expand');
    }

    function refreshNewLinkedMBOMControls() {
        $('#mbom').find('.item').each(function() {
            let elemItem = $(this);
            if(elemItem.hasClass('root') || hasMBOMShortcut(elemItem)) return;

            let linkedMBOM = getLinkedMBOMLinkFromEBOMElement(elemItem);
            if(isBlank(linkedMBOM)) return;

            // Conversion clones an EBOM row without going through the MBOM
            // renderer. Preserve its engineering identity and use the new
            // manufacturing link for navigation and inline expansion.
            let originalLink = elemItem.attr('data-link');
            if(isBlank(elemItem.attr('data-ebom-root'))) {
                elemItem.attr('data-ebom-root', elemItem.attr('data-root'));
            }
            if(isBlank(elemItem.attr('data-ebom')) &&
                normalizePLMLink(originalLink) !== normalizePLMLink(linkedMBOM)) {
                elemItem.attr('data-ebom', originalLink);
            }
            elemItem.attr('data-link', linkedMBOM).attr('data-link-mbom', linkedMBOM);
            elemItem.removeClass('linked-mbom-bom linked-mbom-check-pending linked-mbom-missing ebom-make-item');

            let elemHead = elemItem.children('.item-head').first();
            elemHead.children('.linked-mbom-marker').remove();
            elemHead.off('click');
            elemHead.children('.item-toggle').first().off('click')
                .removeClass('icon icon-expand icon-collapse');

            ensureMBOMShortcutIcons(elemItem);
            enableSubMBOMOperationTarget(elemItem);
            attachCustomMBOMItemSelection(elemItem);
        });
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

        let itemLink = elemItem.attr('data-link');
        if(!isBlank(itemLink)) return normalizePLMLink(itemLink);

        let edgeId = elemItem.attr('data-edge');
        if(!isBlank(edgeId)) return 'edge:' + edgeId;

        let targetKey = elemItem.attr('data-raw-material-target-key');
        if(isBlank(targetKey)) {
            targetKey = 'new-operation:' + (++rawMaterialTargetSequence);
            elemItem.attr('data-raw-material-target-key', targetKey);
        }

        return targetKey;
    }

    function getMBOMItemForPart(part) {
        let mbomLink = getPartItemLink(part);
        if(isBlank(mbomLink)) {
            console.warn('MBOM custom: MBOM part link missing for raw material source', part);
            return $();
        }

        let normalizedLink = normalizePLMLink(mbomLink);
        let elemMBOMItem = $();
        let edgeId = part.edgeId || '';

        $('#mbom').find('.item').each(function() {
            let elemCandidate = $(this);
            if(!isBlank(edgeId) && elemCandidate.attr('data-edge') === String(edgeId)) {
                elemMBOMItem = elemCandidate;
                return false;
            }

            let candidateLinks = [
                elemCandidate.attr('data-link'),
                elemCandidate.attr('data-link-mbom')
            ];

            if(candidateLinks.some(function(candidateLink) {
                return !isBlank(candidateLink) && normalizePLMLink(candidateLink) === normalizedLink;
            })) {
                elemMBOMItem = elemCandidate;
                return false;
            }
        });

        if(elemMBOMItem.length === 0) {
            console.warn('MBOM custom: could not find rendered MBOM item for raw material source', {
                mbomLink   : mbomLink,
                material   : getMaterialValue(part),
                partNumber : getPartNumber(part)
            });
            return $();
        }

        console.log('MBOM custom: matched raw material source directly to MBOM item', {
            mbomLink   : mbomLink,
            targetItem : describeMBOMItem(elemMBOMItem)
        });
        return elemMBOMItem;
    }

    function getRawMaterialTargetHeader(part) {
        let mbomLink = getPartItemLink(part);
        let elemMBOMItem = getMBOMItemForPart(part);
        if(!elemMBOMItem || elemMBOMItem.length === 0) {
            console.warn('MBOM custom: raw material skipped because its MBOM source item is not rendered', {
                mbomLink  : mbomLink,
                material  : getMaterialValue(part),
                partNumber: getPartNumber(part)
            });
            return $();
        }

        let elemProcessHeader = getFirstDirectProcessChildHeader(elemMBOMItem);
        if(elemProcessHeader.length > 0) {
            ensureInlineSubMBOMContainer(elemProcessHeader.closest('.item'));
            console.log('MBOM custom: using first direct process child of MBOM item as raw material target', {
                mbomLink      : mbomLink,
                material      : getMaterialValue(part),
                linkedTarget  : describeMBOMItem(elemMBOMItem),
                processTarget : describeMBOMItem(elemProcessHeader.closest('.item'))
            });
            return elemProcessHeader;
        }

        // The editor also assigns .process to the main mBOM root so it can be
        // selected as a structural target. Only a real operation may receive
        // raw material directly.
        if(elemMBOMItem.hasClass('process') && !isMBOMTechnologyItem(elemMBOMItem)) {
            let elemOwnHeader = elemMBOMItem.children('.item-head').first();
            if(elemOwnHeader.length > 0) {
                ensureInlineSubMBOMContainer(elemMBOMItem);
                console.log('MBOM custom: using MBOM process node itself as raw material target', {
                    mbomLink      : mbomLink,
                    material      : getMaterialValue(part),
                    processTarget : describeMBOMItem(elemMBOMItem)
                });
                return elemOwnHeader;
            }
        }

        console.info('MBOM custom: MBOM item has no direct process child after expansion', {
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

    function searchRawMaterialItems(material) {
        let cacheKey = normalizeComparisonValue(material);
        if(!isBlank(cacheKey) && rawMaterialSearchPromises[cacheKey]) {
            return rawMaterialSearchPromises[cacheKey];
        }

        let encodedMaterial = encodeURIComponent(material);
        let query = 'ITEM_DETAILS:TITLE%3D%22' + encodedMaterial + '%22';
        let params = {
            wsId   : rawMaterialsWorkspaceId,
            limit  : 100,
            offset : 0,
            query  : query,
            revision : 2
        };

        console.log('MBOM custom: raw material title search started', {
            workspaceId : rawMaterialsWorkspaceId,
            material    : material,
            query       : query
        });

        let searchPromise = new Promise(function(resolve) {
            $.get('/plm/search-bulk', params)
                .done(function(response) {
                    if(!response || response.error || !response.data || !Array.isArray(response.data.items)) {
                        resolve({ material: material, items: [], query: query, error: true });
                        return;
                    }
                    let items = (response && response.data && response.data.items) ? response.data.items : [];
                    let filteredItems = items.filter(function(item) {
                        return itemLooksLikeMatchingRawMaterial(item, material);
                    });
                    let releasedItems = filteredItems.filter(isReleasedRawMaterialItem);
                    let unreleasedOnly = filteredItems.length > 0 && releasedItems.length === 0;

                    console.log('MBOM custom: raw material title search finished', {
                        material    : material,
                        totalResults: items.length,
                        titleMatches   : filteredItems.length,
                        releasedMatches: releasedItems.length
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

                    resolve({
                        material       : material,
                        items          : releasedItems,
                        matchingItems  : filteredItems,
                        unreleasedOnly : unreleasedOnly,
                        query          : query
                    });
                })
                .fail(function(jqXHR, textStatus, errorThrown) {
                    console.warn('MBOM custom: raw material title search failed', {
                        material   : material,
                        query      : query,
                        status     : jqXHR ? jqXHR.status : null,
                        textStatus : textStatus || '',
                        error      : errorThrown || ''
                    });
                    resolve({ material: material, items: [], query: query, error: true });
                });
        });

        if(!isBlank(cacheKey)) rawMaterialSearchPromises[cacheKey] = searchPromise;
        return searchPromise;
    }

    function ensureRawMaterialSearchResult(result, productGroup) {
        if(result.error) throw new Error('Wyszukiwanie surowca nie powiodło się: ' + result.material);
        if(result.items.length > 0) return Promise.resolve(result);
        if(result.unreleasedOnly === true) return Promise.resolve(result);
        let key = normalizeComparisonValue(result.material);
        if(!rawMaterialCreationPromises[key]) {
            rawMaterialCreationPromises[key] = createRawMaterialItem(result.material, productGroup).then(function(item) {
                let createdResult = {
                    material       : result.material,
                    items          : [],
                    matchingItems  : [item],
                    unreleasedOnly : true,
                    created        : true,
                    query          : result.query
                };
                rawMaterialSearchPromises[key] = Promise.resolve(createdResult);
                return createdResult;
            }).catch(function(error) {
                delete rawMaterialCreationPromises[key];
                throw error;
            });
        }
        return rawMaterialCreationPromises[key];
    }

    async function createRawMaterialItem(material, productGroup) {
        if(isBlank(material)) throw new Error('Nie można utworzyć surowca bez wartości pola MATERIAL.');
        if(isBlank(productGroup)) throw new Error('Nie można utworzyć surowca „' + material + '” bez wartości pola GRUPA_PRODUKTOWA_SUROWCOW.');
        let responses = await Promise.all([
            $.get('/plm/sections', { wsId: rawMaterialsWorkspaceId }),
            $.get('/plm/fields', { wsId: rawMaterialsWorkspaceId })
        ]);
        if(responses.some(function(response) { return !response || response.error || !Array.isArray(response.data); })) {
            throw new Error('Nie można wczytać pól obszaru roboczego surowców.');
        }
        let values = {
            GRUPA_PRODUKTOWA: productGroup, NUMBER: '', TITLE: material,
            NAZWA: material, NAZWA_DEFRO: material, TYPE: rawMaterialTypeName,
            TYP_CZESCI: 'S', RODZAJ: 'Surowiec', WARIANT: 'Surowiec', SPECYFIKACJA: 'Surowiec'
        };
        let fields = await Promise.all(Object.keys(values).map(async function(fieldId) {
            let metadata = responses[1].data.find(function(field) {
                return (field.__self__ || field.link || '').split('/').pop() === fieldId;
            });
            if(!metadata) throw new Error('Brak pola surowca: ' + fieldId);
            let value = values[fieldId];
            if(fieldId === 'TYPE') {
                // Match the existing MBOM/Process creation contract: TYPE is an option link.
                let picklistLink = metadata.picklist || metadata.lookups;
                if(isBlank(picklistLink)) {
                    let configuredTypeValue = (typeof config !== 'undefined' && config.mbomRoot)
                        ? String(config.mbomRoot.typeValue || '') : '';
                    let optionsMarker = configuredTypeValue.indexOf('/options/');
                    picklistLink = optionsMarker > 0
                        ? configuredTypeValue.substring(0, optionsMarker)
                        : '/api/v3/lookups/CUSTOM_LOOKUP_ITEM_TYPES';
                }
                let offset = 0;
                let option;
                while(!option) {
                    let response = await $.get('/plm/picklist', { link: picklistLink, limit: 250, offset: offset, useCache: false });
                    if(!response || response.error || !response.data || !Array.isArray(response.data.items)) {
                        throw new Error('Nie można wczytać opcji pola surowca: ' + fieldId);
                    }
                    let items = response.data.items;
                    option = items.find(function(item) {
                        return normalizeComparisonValue(item.title || item.label || item.value) === normalizeComparisonValue(value);
                    });
                    if(option || items.length < 250) break;
                    offset += items.length;
                }
                if(!option || !(option.link || option.__self__)) throw new Error('Brak opcji dla pola ' + fieldId + ': ' + value);
                value = { link: option.link || option.__self__ };
            }
            return { fieldId: fieldId, value: value };
        }));
        let response = await $.post({
            url: '/plm/create', contentType: 'application/json',
            data: JSON.stringify({ wsId: rawMaterialsWorkspaceId, sections: responses[0].data, fields: fields })
        });
        if(!response || response.error) {
            console.warn('MBOM custom: PLM rejected raw material creation', { material: material, response: response });
            throw new Error('Nie udało się utworzyć surowca: ' + material + '. ' + getRawMaterialErrorMessage(response));
        }
        let link = response.data && response.data.__self__ ? response.data.__self__ : response.data;
        if(typeof link !== 'string' || isBlank(link)) throw new Error('Utworzony surowiec nie zwrócił odnośnika do elementu.');
        return { __self__: link.replace(/^https?:\/\/[^/]+/i, ''), title: material };
    }

    function getRawMaterialErrorMessage(error) {
        if(!error) return 'PLM returned no response.';
        let response = error.responseJSON || error;
        if(!isBlank(response.message)) return String(response.message);
        if(!isBlank(response.responseText)) return String(response.responseText);
        if(response.data && (!Array.isArray(response.data) || response.data.length > 0)) {
            return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
        }
        return 'Żądanie PLM nie powiodło się' + (response.status ? ' (HTTP ' + response.status + ')' : '') + '.';
    }

    function resolveRawMaterialForBatch(material, allowCreate, productGroup) {
        return Promise.resolve().then(function() {
            return searchRawMaterialItems(material);
        }).then(function(result) {
            return allowCreate === false ? result : ensureRawMaterialSearchResult(result, productGroup);
        }).catch(function(error) {
            // A failed material must not prevent unrelated branches from being applied.
            // Re-query on the next attempt in case PLM created an item before a connection failed.
            delete rawMaterialSearchPromises[normalizeComparisonValue(material)];
            let message = getRawMaterialErrorMessage(error);
            console.warn('MBOM custom: raw material could not be prepared', { material: material, error: error });
            return { material: material, items: [], error: true, message: message };
        });
    }

    function getSearchItemLink(item) {
        if(!item) return '';
        let candidates = [
            item.__self__,
            item.link,
            item.item && item.item.link,
            item.item && item.item.__self__
        ].filter(function(link) { return !isBlank(link); });
        let versionLink = candidates.find(function(link) {
            return /\/versions\/\d+(?:[/?#]|$)/i.test(String(link));
        });
        return versionLink || candidates[0] || '';
    }

    function normalizeProcessLookupName(value) {
        let normalized = normalizeComparisonValue(value);
        if(typeof normalized.normalize === 'function') {
            normalized = normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        }
        return normalized.replace(/ł/g, 'l');
    }

    function findAddProcessWorkspaceItemByName(items, processName) {
        let normalizedName = normalizeProcessLookupName(processName);
        let fallbackMatch = null;

        for(let item of (Array.isArray(items) ? items : [])) {
            let normalizedTitle = normalizeProcessLookupName(getAddProcessItemTitle(item));
            if(normalizedTitle === normalizedName) return item;

            if(!fallbackMatch && (
                normalizedTitle.indexOf(normalizedName + ' ') === 0 ||
                normalizedTitle.indexOf(normalizedName + ' -') === 0
            )) {
                fallbackMatch = item;
            }
        }

        return fallbackMatch;
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

    function getRawMaterialSearchProperty(item, propertyNames) {
        let names = Array.isArray(propertyNames) ? propertyNames : [propertyNames];
        let sources = [item, item && item.item].filter(Boolean);

        for(let source of sources) {
            for(let name of names) {
                if(Object.prototype.hasOwnProperty.call(source, name)) return source[name];
            }
        }

        return undefined;
    }

    function isReleasedRawMaterialItem(item) {
        let working = getRawMaterialSearchProperty(item, ['isWorkingVersion', 'workingVersion']);
        if(typeof working !== 'undefined') {
            if(typeof working === 'string') working = /^(true|1|yes)$/i.test(working.trim());
            if(typeof working === 'number') working = working !== 0;
            return working === false;
        }

        let state = getRawMaterialSearchProperty(item, [
            'lifecycleState', 'lifecycle-state', 'currentState', 'status'
        ]);
        if(state && typeof state === 'object') state = state.title || state.name || state.value || '';
        let normalizedState = normalizeComparisonValue(state);
        if(['released', 'release', 'zwolniony', 'zwolniona', 'zwolnione'].includes(normalizedState)) return true;

        let revision = getRawMaterialSearchProperty(item, ['revision', 'version']);
        return !isBlank(revision) && normalizeComparisonValue(revision) !== 'w';
    }

    function getRawMaterialVersionOrder(item) {
        let value = getRawMaterialSearchProperty(item, ['versionId', 'versionID', 'revision']);
        let numericValue = Number(value);
        return Number.isNaN(numericValue) ? String(value || '') : numericValue;
    }

    function chooseRawMaterialItem(material, items) {
        if(!Array.isArray(items) || items.length === 0) return null;

        let exactMatches = items.filter(function(item) {
            return itemLooksLikeMatchingRawMaterial(item, material) && isReleasedRawMaterialItem(item);
        });

        exactMatches.sort(function(left, right) {
            let leftOrder = getRawMaterialVersionOrder(left);
            let rightOrder = getRawMaterialVersionOrder(right);
            if(typeof leftOrder === 'number' && typeof rightOrder === 'number') return rightOrder - leftOrder;
            return String(rightOrder).localeCompare(String(leftOrder), undefined, { numeric : true });
        });

        if(exactMatches.length > 1) {
            console.warn('MBOM custom: multiple released raw material TITLE values found, using latest result', {
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

    function getRawMaterialUnitOfMeasure(item) {
        if(!item) return '';

        let unitCandidates = [
            'UNIT_OF_MEASURE',
            'UOM',
            'UNIT',
            'BOM_UOM',
            'ITEM_UOM',
            rawMaterialAccountingUnitFieldId
        ];

        for(let fieldId of unitCandidates) {
            let value = normalizeMBOMUnitOfMeasureValue(getSearchItemFieldValue(item, fieldId));
            if(!isBlank(value)) return value;
        }

        return '';
    }

    function getRawMaterialUnitOfMeasureFromItemDetails(itemDetails) {
        if(!itemDetails || !itemDetails.sections) return '';

        let candidateIds = [
            'UNIT_OF_MEASURE',
            'UOM',
            'UNIT',
            'BOM_UOM',
            'ITEM_UOM',
            rawMaterialAccountingUnitFieldId
        ];

        for(let fieldId of candidateIds) {
            let value = normalizeMBOMUnitOfMeasureValue(
                getSectionFieldValue(itemDetails.sections, fieldId, '', 'object')
            );
            if(!isBlank(value)) return value;
        }

        return '';
    }

    function resolveRawMaterialUnitOfMeasure(item) {
        let unitOfMeasure = getRawMaterialUnitOfMeasure(item);
        if(!isBlank(unitOfMeasure)) return Promise.resolve(unitOfMeasure);

        let link = getSearchItemLink(item);
        if(isBlank(link)) return Promise.resolve('');

        return getRawMaterialItemDetails(link)
            .then(function(detailsData) {
                return getRawMaterialUnitOfMeasureFromItemDetails(detailsData);
            })
            .catch(function(error) {
                console.warn('MBOM custom: could not load raw material UOM', {
                    rawMaterialLink : link,
                    error           : error
                });
                return '';
            });
    }

    function getRawMaterialItemDetails(link) {
        let cacheKey = normalizePLMLink(link);
        if(isBlank(cacheKey)) return Promise.reject(new Error('Odnośnik do surowca jest pusty.'));
        if(rawMaterialItemDetailsPromises[cacheKey]) return rawMaterialItemDetailsPromises[cacheKey];

        rawMaterialItemDetailsPromises[cacheKey] = $.get('/plm/details', { link : link })
            .then(function(response) {
                if(!response || response.error || !response.data) {
                    throw new Error('Nie udało się wczytać szczegółów surowca.');
                }
                return response.data;
            })
            .catch(function(error) {
                delete rawMaterialItemDetailsPromises[cacheKey];
                throw error;
            });

        return rawMaterialItemDetailsPromises[cacheKey];
    }

    function normalizeRawMaterialUnitForComparison(value) {
        if(isBlank(value)) return '';

        let normalized = normalizeComparisonValue(value)
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/²/g, '2');
        let mappings = {
            'ea'                : 'each',
            'each'              : 'each',
            'pc'                : 'each',
            'pcs'               : 'each',
            'piece'             : 'each',
            'pieces'            : 'each',
            'szt'               : 'each',
            'szt.'              : 'each',
            'mm'                : 'millimeter',
            'millimeter'        : 'millimeter',
            'millimeters'       : 'millimeter',
            'cm'                : 'centimeter',
            'centimeter'        : 'centimeter',
            'centimeters'       : 'centimeter',
            'dm'                : 'decimeter',
            'decimeter'         : 'decimeter',
            'decimeters'        : 'decimeter',
            'm'                 : 'meter',
            'meter'             : 'meter',
            'meters'            : 'meter',
            'km'                : 'kilometer',
            'kilometer'         : 'kilometer',
            'kilometers'        : 'kilometer',
            'mm2'               : 'square millimeter',
            'square millimeter' : 'square millimeter',
            'cm2'               : 'square centimeter',
            'square centimeter' : 'square centimeter',
            'dm2'               : 'square decimeter',
            'square decimeter'  : 'square decimeter',
            'm2'                : 'square meter',
            'square meter'      : 'square meter',
            'km2'               : 'square kilometer',
            'square kilometer'  : 'square kilometer',
            'mm3'               : 'cubic millimeter',
            'cubic millimeter'  : 'cubic millimeter',
            'cm3'               : 'cubic centimeter',
            'cubic centimeter'  : 'cubic centimeter',
            'dm3'               : 'cubic decimeter',
            'cubic decimeter'   : 'cubic decimeter',
            'm3'                : 'cubic meter',
            'cubic meter'       : 'cubic meter',
            'ml'                : 'milliliter',
            'milliliter'        : 'milliliter',
            'milliliters'       : 'milliliter',
            'l'                 : 'liter',
            'liter'             : 'liter',
            'liters'            : 'liter',
            'mg'                : 'milligram',
            'milligram'         : 'milligram',
            'milligrams'        : 'milligram',
            'g'                 : 'gram',
            'gram'              : 'gram',
            'grams'             : 'gram',
            'kg'                : 'kilogram',
            'kilogram'          : 'kilogram',
            'kilograms'         : 'kilogram',
            't'                 : 'metric ton',
            'tonne'             : 'metric ton',
            'tonnes'            : 'metric ton',
            'metric ton'        : 'metric ton',
            's'                 : 'second',
            'sec'               : 'second',
            'second'            : 'second',
            'seconds'           : 'second',
            'min'               : 'minute',
            'minute'            : 'minute',
            'minutes'           : 'minute',
            'h'                 : 'hour',
            'hr'                : 'hour',
            'hour'              : 'hour',
            'hours'             : 'hour'
        };

        return mappings[normalized] || normalized;
    }

    function rawMaterialUnitsMatch(mbomUnit, rawMaterialUnit) {
        let normalizedMBOMUnit = normalizeRawMaterialUnitForComparison(mbomUnit);
        let normalizedRawMaterialUnit = normalizeRawMaterialUnitForComparison(rawMaterialUnit);

        return normalizedMBOMUnit !== '' &&
            normalizedRawMaterialUnit !== '' &&
            normalizedMBOMUnit === normalizedRawMaterialUnit;
    }

    function getValidatedRawMaterialInsertQuantity(accountingQuantity, accountingUnit, rawMaterialUnit) {
        let quantity = parseNumericValue(accountingQuantity);

        if(Number.isNaN(quantity) || quantity <= 0) return NaN;

        return quantity;
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
        let accountingUnit = entry ? entry.accountingUnit : '';
        let accountingQuantity = entry ? entry.accountingQuantity : NaN;

        return resolveRawMaterialUnitOfMeasure(item).then(function(rawMaterialUnit) {
            let unitsMatch = rawMaterialUnitsMatch(accountingUnit, rawMaterialUnit);
            let insertQuantity = getValidatedRawMaterialInsertQuantity(
                accountingQuantity,
                accountingUnit,
                rawMaterialUnit
            );

            console.log('MBOM custom: raw material accounting quantity decision', {
                mbomLink           : getPartItemLink(part),
                partNumber         : getPartNumber(part),
                material           : entry ? entry.material : '',
                accountingUnit     : accountingUnit,
                accountingQuantity : accountingQuantity,
                rawMaterialLink    : getSearchItemLink(item),
                rawMaterialUOM     : rawMaterialUnit,
                unitsMatch         : unitsMatch,
                insertQuantity     : insertQuantity
            });

            if(entry) {
                entry.uomChecked = true;
                entry.uomMismatch = unitsMatch
                    ? null
                    : {
                        mbomLink        : getPartItemLink(part),
                        partNumber      : getPartNumber(part),
                        material        : entry.material,
                        mbomUnit        : accountingUnit,
                        rawMaterialLink : getSearchItemLink(item),
                        rawMaterialUOM  : rawMaterialUnit
                    };
            }

            if(Number.isNaN(accountingQuantity) || accountingQuantity <= 0) {
                console.warn('MBOM custom: raw material skipped because MBOM ILOSC_ROZLICZENIOWA is missing or invalid', {
                    mbomLink : getPartItemLink(part),
                    value    : accountingQuantity
                });
                return NaN;
            }

            if(!unitsMatch) {
                console.warn('MBOM custom: raw material unit warning: JEDNOSTKA_ROZLICZENIOWA does not match the raw material UOM; continuing with ILOSC_ROZLICZENIOWA', {
                    mbomLink        : getPartItemLink(part),
                    material        : entry ? entry.material : '',
                    accountingUnit  : accountingUnit,
                    rawMaterialLink : getSearchItemLink(item),
                    rawMaterialUOM  : rawMaterialUnit
                });
            }

            return insertQuantity;
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

    function normalizePLMVersionLink(link) {
        if(isBlank(link)) return '';

        let normalized = String(link).trim().replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0];
        let versionMatch = normalized.match(/\/api\/v3\/workspaces\/\d+\/items\/\d+(?:\/versions\/\d+)?/i);
        return (versionMatch ? versionMatch[0] : normalized).toLowerCase();
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
        let normalizedVersionLink = normalizePLMVersionLink(link);
        let requiresExactVersion = normalizedVersionLink.indexOf('/versions/') >= 0;

        elemHeader.next().children('.item').each(function() {
            let elemItem = $(this);
            let candidateLinks = [
                elemItem.attr('data-link'),
                elemItem.attr('data-link-mbom'),
                elemItem.attr('data-link-db')
            ].filter(function(candidate) { return !isBlank(candidate); });

            let matches = requiresExactVersion
                ? candidateLinks.some(function(candidate) {
                    return normalizePLMVersionLink(candidate) === normalizedVersionLink;
                })
                : candidateLinks.some(function(candidate) {
                    return normalizePLMLink(candidate) === normalizedLink;
                });

            if(matches) {
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

    function getSelectedProcessParentItem() {
        let elemTarget = $('#mbom .item.selected-target').first();
        if(elemTarget.length === 0) {
            elemTarget = $('#mbom-tree').children('.item').first();
        }

        if(elemTarget.length > 0 && elemTarget.hasClass('process') && !elemTarget.hasClass('root')) {
            let elemParent = elemTarget.parent().closest('.item');
            if(elemParent.length > 0) elemTarget = elemParent;
        }

        return elemTarget;
    }

    function getProcessParentBOM(elemParentItem, createIfMissing) {
        let elemTarget = elemParentItem && elemParentItem.length > 0
            ? elemParentItem
            : getSelectedProcessParentItem();

        if(elemTarget.length === 0) return $();

        let elemBOM = elemTarget.children('.item-bom').first();
        if(elemBOM.length === 0 && createIfMissing) {
            elemBOM = ensureInlineSubMBOMContainer(elemTarget);
        }

        return elemBOM;
    }

    function insertWorkspaceProcessItem(selectedItem, elemParentItem, fallbackTitle) {
        if(!selectedItem || !elemParentItem || elemParentItem.length === 0) return $();

        let title = getAddProcessItemTitle(selectedItem);
        if(isBlank(title)) title = fallbackTitle || '';
        if(isBlank(title)) return $();

        let elemBOM = getProcessParentBOM(elemParentItem, true);
        if(elemBOM.length === 0) return $();

        let node = {
            level       : getElementLevel(elemParentItem) + 1,
            bomType     : 'mbom',
            title       : title,
            hasChildren : true,
            isEBOMItem  : false,
            isProcess   : true,
            isLeaf      : false,
            icon        : 'radio-process',
            code        : getNextProcessCode(elemBOM),
            revision    : '-',
            quantity    : 1
        };

        let elemNew = insertBOMPartListNode('mbom', null, node);
        if(disassembleMode) elemBOM.prepend(elemNew);
        else elemBOM.append(elemNew);

        updateMBOMNumbers();
        return elemNew;
    }

    function getNextProcessCode(elemBOM) {
        let highestCode = 0;
        let elemTargetBOM = elemBOM && elemBOM.length > 0 ? elemBOM : getProcessParentBOM();

        elemTargetBOM.children('.item.process').each(function() {
            let elemItem = $(this);
            let value = elemItem.attr('data-code') || elemItem.find('.item-code').first().text() || '';
            let numericValue = parseProcessSequenceCode(value);

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
        attachCustomMBOMItemSelection(elemItem);

        elemItem.addClass('selected');
        selectProcess(elemItem);
    }

    function findLinkedEBOMItemForMBOM(elemItem) {
        if(!elemItem || elemItem.length === 0) return $();

        let directEBOMLink = elemItem.attr('data-ebom') || elemItem.attr('data-link-ebom') || '';
        let ebomRootLink = elemItem.attr('data-ebom-root') || '';
        let mbomRootLink = elemItem.attr('data-root') || '';
        let partNumber = elemItem.attr('data-part-number') || '';
        let elemMatch = $();

        $('#ebom .item').each(function() {
            let elemEBOMItem = $(this);
            let ebomItemLink = elemEBOMItem.attr('data-link') || '';
            let ebomItemRoot = elemEBOMItem.attr('data-ebom-root') || elemEBOMItem.attr('data-root') || '';

            if(!isBlank(directEBOMLink) &&
                normalizePLMLink(directEBOMLink) === normalizePLMLink(ebomItemLink)) {
                elemMatch = elemEBOMItem;
                return false;
            }

            if(!isBlank(ebomRootLink) &&
                normalizePLMLink(ebomRootLink) === normalizePLMLink(ebomItemRoot)) {
                elemMatch = elemEBOMItem;
                return false;
            }

            if(isBlank(ebomRootLink) &&
                !isBlank(mbomRootLink) &&
                normalizePLMLink(mbomRootLink) === normalizePLMLink(ebomItemRoot)) {
                elemMatch = elemEBOMItem;
                return false;
            }
        });

        if(elemMatch.length > 0 || isBlank(partNumber)) return elemMatch;

        $('#ebom .item').each(function() {
            let elemEBOMItem = $(this);
            if((elemEBOMItem.attr('data-part-number') || '') === partNumber) {
                elemMatch = elemEBOMItem;
                return false;
            }
        });

        return elemMatch;
    }

    function findLinkedMBOMItemForEBOM(elemItem) {
        if(!elemItem || elemItem.length === 0) return $();

        let linkedMBOM = getLinkedMBOMLinkFromEBOMElement(elemItem);
        if(!isBlank(linkedMBOM)) {
            let elemLinkedMBOM = findRenderedMBOMItemByLink(linkedMBOM);
            if(elemLinkedMBOM.length > 0) return elemLinkedMBOM;
        }

        let ebomLink = elemItem.attr('data-link') || '';
        let ebomRoot = elemItem.attr('data-ebom-root') || elemItem.attr('data-root') || '';
        let partNumber = elemItem.attr('data-part-number') || '';
        let elemMatch = $();

        $('#mbom .item').each(function() {
            let elemMBOMItem = $(this);
            if(elemMBOMItem.hasClass('root') || elemMBOMItem.hasClass('process')) return;

            let linkedEBOM = elemMBOMItem.attr('data-ebom') || elemMBOMItem.attr('data-link-ebom') || '';
            let mbomRoot = elemMBOMItem.attr('data-ebom-root') || elemMBOMItem.attr('data-root') || '';

            if(!isBlank(ebomLink) &&
                !isBlank(linkedEBOM) &&
                normalizePLMLink(ebomLink) === normalizePLMLink(linkedEBOM)) {
                elemMatch = elemMBOMItem;
                return false;
            }

            if(!isBlank(ebomRoot) &&
                normalizePLMLink(ebomRoot) === normalizePLMLink(mbomRoot)) {
                elemMatch = elemMBOMItem;
                return false;
            }
        });

        if(elemMatch.length > 0 || isBlank(partNumber)) return elemMatch;

        $('#mbom .item').each(function() {
            let elemMBOMItem = $(this);
            if(elemMBOMItem.hasClass('root') || elemMBOMItem.hasClass('process')) return;
            if((elemMBOMItem.attr('data-part-number') || '') === partNumber) {
                elemMatch = elemMBOMItem;
                return false;
            }
        });

        return elemMatch;
    }

    function getLinkedEBOMAncestor(elemItem) {
        let elemCurrent = elemItem;

        while(elemCurrent && elemCurrent.length > 0) {
            if(!isBlank(getLinkedMBOMLinkFromEBOMElement(elemCurrent))) return elemCurrent;
            elemCurrent = elemCurrent.parent().closest('.item');
        }

        return $();
    }

    function focusLinkedMBOMItemForEBOM(elemEBOMItem) {
        let elemMBOMItem = findLinkedMBOMItemForEBOM(elemEBOMItem);
        if(elemMBOMItem.length > 0) {
            revealLinkedMBOMItem(elemMBOMItem);
            return;
        }

        let elemLinkedAncestor = getLinkedEBOMAncestor(elemEBOMItem);
        if(elemLinkedAncestor.length === 0) return;

        let linkedMBOM = getLinkedMBOMLinkFromEBOMElement(elemLinkedAncestor);
        let elemLinkedMBOM = findRenderedMBOMItemByLink(linkedMBOM);
        if(elemLinkedMBOM.length === 0) return;

        ensureInlineSubMBOMExpanded(elemLinkedMBOM).then(function(success) {
            if(!success) return;

            completeLinkedEBOMBOMCheckForMBOM(elemLinkedMBOM);
            let elemResolvedMBOM = findLinkedMBOMItemForEBOM(elemEBOMItem);
            revealLinkedMBOMItem(elemResolvedMBOM.length > 0 ? elemResolvedMBOM : elemLinkedMBOM);
        });
    }

    function selectCustomMBOMItem(elemItem) {
        if(!elemItem || elemItem.length === 0) return;

        if(elemItem.hasClass('process')) {
            // The stock selector expects the clicked process to be selected
            // already. Newly clicked operations otherwise clear the current
            // target without becoming the new target.
            elemItem.addClass('selected');
            selectProcess(elemItem);
            return;
        }

        let elemEBOMItem = findLinkedEBOMItemForMBOM(elemItem);
        if(elemEBOMItem.length > 0) {
            let wasSelected = elemEBOMItem.hasClass('selected');

            $('.selected-target').removeClass('selected-target');
            selectBOMItem(elemEBOMItem, false);

            if(!wasSelected && elemItem.hasClass('selected')) {
                elemItem.addClass('selected-target');
            }
            revealLinkedEBOMItem(elemEBOMItem);
            return;
        }

        if(elemItem.hasClass('leaf')) {
            selectBOMItem(elemItem, false);
            return;
        }

        selectProcess(elemItem);
    }

    function attachCustomMBOMItemSelection(elemItem) {
        if(!elemItem || elemItem.length === 0) return;

        // The stock renderer attaches both component and process handlers to
        // non-leaf nodes. Keep a single handler so cross-selection is not
        // immediately cleared by the process-selection handler.
        elemItem.off('click').on('click.custom-mbom-selection', function(e) {
            e.stopPropagation();
            e.preventDefault();
            selectCustomMBOMItem($(this));
        });
    }

    function attachCustomMBOMDropGuard(elemItem) {
        let elemHead = elemItem.children('.item-head').first();
        if(elemHead.length === 0 || typeof elemHead.droppable !== 'function') return;
        if(!elemHead.droppable('instance') || elemHead.data('custom-unsaved-drop-guard')) return;

        let originalDrop = elemHead.droppable('option', 'drop');
        if(typeof originalDrop !== 'function') return;

        elemHead.data('custom-unsaved-drop-guard', true);
        elemHead.droppable('option', 'drop', function(event, ui) {
            let elemDragged = ui.draggable;
            if(!elemDragged.hasClass('additional-item') && isBlank(elemDragged.attr('data-link'))) {
                // Unsaved operations have no shared PLM identity. Move the
                // whole row via sortable.stop without merging it into a peer.
                let elemTargetBOM = $(this).next('.item-bom');
                if(elemTargetBOM.length === 0 || elemDragged[0].contains(elemTargetBOM[0])) {
                    elemBOMDropped = elemDragged.parent();
                } else {
                    elemBOMDropped = elemTargetBOM;
                }
                return;
            }

            return originalDrop.apply(this, arguments);
        });
    }

    if(typeof moveItemInBOM === 'function') {
        let originalMoveItemInBOM = moveItemInBOM;
        moveItemInBOM = function(elemItem) {
            // An empty link identifies a new row, not a duplicate PLM item.
            if(isBlank(elemItem.attr('data-link'))) return;
            return originalMoveItemInBOM.apply(this, arguments);
        };
    }

    function validateMBOMComponentTarget() {
        let elemTarget = $('#mbom .item.selected-target').first();
        let isOperationTarget = elemTarget.length > 0 &&
            elemTarget.hasClass('process') &&
            !elemTarget.hasClass('root');

        if(!isOperationTarget) {
            showErrorMessage('Add Component', 'Select an operation in the Manufacturing BOM first. Components can only be added below operations.');
            return false;
        }

        return true;
    }

    function setupCustomEBOMItemFocus() {
        let elemEBOM = document.getElementById('ebom');
        if(!elemEBOM || elemEBOM.getAttribute('data-linked-focus-ready') === 'true') return;

        elemEBOM.setAttribute('data-linked-focus-ready', 'true');
        elemEBOM.addEventListener('click', function(e) {
            let elemTarget = $(e.target);

            // Validate before the conversion click handler opens its dialog
            // or creates a linked MBOM, including standard conversion actions.
            if(elemTarget.closest('.item-action-convert').length > 0 && !validateMBOMComponentTarget()) {
                e.preventDefault();
                e.stopImmediatePropagation();
                return;
            }

            // Keep dedicated controls independent. The production-hall icon
            // retains its own load-and-focus behavior.
            if(elemTarget.closest('.linked-mbom-marker, .item-actions, .item-toggle, input, select, button, a').length > 0) return;

            let elemItem = elemTarget.closest('.item');
            if(elemItem.length === 0 || elemItem.closest('#ebom').length === 0) return;

            focusLinkedMBOMItemForEBOM(elemItem);
        }, true);
    }

    function enableSubMBOMOperationTarget(elemItem) {
        if(!elemItem || elemItem.length === 0) return;
        if(elemItem.hasClass('process') || !hasMBOMShortcut(elemItem)) return;

        ensureInlineSubMBOMContainer(elemItem);

        elemItem
            .addClass('submbom-operation-target');
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
                }, {
                    fieldId : 'NAZWA_URZDZENIA',
                    value   : assemblyIndexPLMDefaults.nazwa_urzadzenia
                }, {
                    fieldId : 'MOC',
                    value   : assemblyIndexPLMDefaults.moc
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

    function getMBOMOverviewContext() {
        let elemRoot = $('#mbom-tree').children('.item').first();
        let link = elemRoot.attr('data-link') || '';

        if(typeof links !== 'undefined' && links && !isBlank(links.mbom)) {
            link = links.mbom;
        }

        return {
            link       : getPLMItemLevelLink(link),
            descriptor : getERPTechnologyDescriptor(elemRoot)
        };
    }

    function ensureMBOMOverviewDialog(id) {
        let elemDialog = $('#' + id);
        if(elemDialog.length === 0) {
            elemDialog = $('<div></div>')
                .attr('id', id)
                .appendTo('body');
        }
        return elemDialog;
    }

    function openMBOMOverview() {
        let context = getMBOMOverviewContext();
        if(isBlank(context.link)) {
            showErrorMessage('Przegląd mBOM', 'Nie znaleziono zapisanego mBOM.');
            return;
        }

        ensureMBOMOverviewDialog('mbom-overview-dialog');
        insertBOM(context.link, {
            id               : 'mbom-overview-dialog',
            headerLabel      : 'Przegląd mBOM',
            headerSubLabel   : context.descriptor,
            showInDialog     : true,
            bomViewName      : config.workspaceMBOM.bomView,
            revisionBias     : 'working',
            depth            : config.workspaceMBOM.depth,
            fieldsIn         : ['Item', 'Quantity', 'Qty'],
            contentSize      : 's',
            collapseContents : true,
            counters         : true,
            openInPLM        : true,
            path             : true,
            reload           : true,
            search           : true,
            toggles          : true
        });

        $('#overlay').show();
    }

    function insertMBOMOverviewButtons() {
        if($('#mbom-overview-row').length > 0) return;

        insertAddAssemblyIndexButton();

        let elemAssemblyRow = $('#mbom-add-assembly-index-row');
        if(elemAssemblyRow.length === 0) return;

        let elemRow = $('<div></div>')
            .attr('id', 'mbom-overview-row')
            .insertBefore(elemAssemblyRow);

        $('<div></div>')
            .attr('id', 'mbom-open-overview')
            .addClass('button')
            .attr('title', 'Pokaż zapisaną strukturę mBOM')
            .text('Przegląd mBOM')
            .click(openMBOMOverview)
            .appendTo(elemRow);

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

        let elemParentItem = getSelectedProcessParentItem();
        let elemNew = insertWorkspaceProcessItem(selectedItem, elemParentItem, title);

        if(elemNew.length === 0) {
            showErrorMessage('Add Process', 'Could not find the selected MBOM target.');
            return false;
        }
        elemParentItem.addClass('selected');
        selectProcess(elemParentItem);

        $('#mbom-add-name').val('');
        $('#mbom-add-code').val('');
        $('#mbom-add-name').focus();

        return true;
    }

    function getMBOMSaveLink(elemItem) {
        if(!elemItem || elemItem.length === 0) return '';
        let normalizedLink = getMBOMChildSaveLink(elemItem);
        return normalizedLink || elemItem.attr('data-link-mbom') || elemItem.attr('data-link') || '';
    }

    function getMBOMChildSaveLink(elemItem) {
        if(!elemItem || elemItem.length === 0) return '';

        let link = elemItem.attr('data-link-mbom') || elemItem.attr('data-link') || '';
        let itemLink = getPLMItemLevelLink(link);
        if(/^\/api\/v3\/workspaces\/\d+\/items\/\d+$/i.test(itemLink)) return itemLink;

        // Older rendered rows may still contain the legacy dot-separated URN
        // expected by the standard editor.
        let urnParts = String(link).split('.');
        if(!isBlank(urnParts[4]) && !isBlank(urnParts[5])) {
            return '/api/v3/workspaces/' + urnParts[4] + '/items/' + urnParts[5];
        }

        return '';
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
            links        : new Set(),
            versionLinks : new Set(),
            children     : new Map()
        };
    }

    function addExistingChildToState(state, part) {
        if(!state || !part || isBlank(part.link)) return;

        let normalizedLink = normalizePLMLink(part.link);
        if(isBlank(normalizedLink)) return;

        state.links.add(normalizedLink);
        state.versionLinks.add(normalizePLMVersionLink(part.link));
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

    function ensureSaveProcessStep() {
        if($('#step-process').length > 0) return;

        $('<div>', { id : 'step-process', class : 'step' })
            .append($('<div>', { class : 'step-label', text : 'Creating/Updating Process:' }))
            .append($('<div>', { class : 'step-progress' })
                .append($('<div>', { id : 'step-bar-process', class : 'step-bar' })))
            .append($('<div>', { id : 'step-counter-process', class : 'step-counter' }))
            .insertAfter('#step0');
    }

    function initSaveCheckDialog(total) {
        let count = Number(total) || 0;

        ensureSaveProcessStep();

        $('.step-bar').addClass('transition-stopper');
        $('.step-bar').css('width', '0%');
        $('#overlay').show();
        $('#confirm-saving').addClass('disabled').removeClass('default');
        $('.in-work').removeClass('in-work');
        $('#step0').addClass('in-work');
        $('.step-bar').removeClass('transition-stopper');

        $('#step0 .step-label').text('Checking existing BOM entries');
        $('#step-counter0').html('0 of ' + count);
        $('#step-counter-process').html('0 of 3');
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

    function startSaveProcessStep() {
        $('#step-process').addClass('in-work');
        $('#step-bar-process').css('width', '0%');
        $('#step-counter-process').html('0 of 3');
    }

    function updateSaveProcessStep(completed) {
        let done = Math.max(0, Math.min(3, Number(completed) || 0));
        $('#step-bar-process').css('width', (done * 100 / 3) + '%');
        $('#step-counter-process').html(done + ' of 3');
    }

    function completeSaveProcessStep() {
        updateSaveProcessStep(3);
        $('#step-process').removeClass('in-work');
    }

    function syncExistingBOMStateBeforeSave(headers) {
        headers = Array.isArray(headers) ? headers : collectMBOMParentsForSaveSync();
        let started = Date.now();

        console.log('MBOM custom: preparing BOM save state sync', {
            parentCount : headers.length
        });

        if(headers.length === 0) return Promise.resolve();

        let done = 0;
        let concurrency = Math.max(1, Math.min(5, typeof maxRequests === 'number' ? maxRequests : 5));

        return mapPLMRequestsWithConcurrency(headers, concurrency, function(elemHeader) {
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
        }).then(function() {
            console.log('MBOM custom: BOM save state sync finished', {
                parentCount : headers.length,
                concurrency : concurrency,
                durationMs  : Date.now() - started
            });
        });
    }

    function getProcessCodeFromElement(elemProcess) {
        if(!elemProcess || elemProcess.length === 0) return '';

        let value = elemProcess.attr('data-code');
        if(isBlank(value)) {
            value = elemProcess.children('.item-head').children('.item-code').first().text();
        }

        return isBlank(value) ? '' : String(value).trim();
    }

    function parseProcessSequenceCode(value) {
        if(typeof value === 'number') {
            return Number.isFinite(value) && value > 0 ? Math.trunc(value) : NaN;
        }

        if(typeof value !== 'string') return NaN;

        let normalized = value.trim();
        if(!/^\d+(?:[\.,]0+)?$/.test(normalized)) return NaN;

        let parsed = Number(normalized.replace(',', '.'));
        return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : NaN;
    }

    function setProcessCodeDisplay(elemProcess, code, updateStoredValue) {
        if(!elemProcess || elemProcess.length === 0) return;

        let value = String(code);
        elemProcess.children('.item-head').children('.item-code').first().text(value);
        if(updateStoredValue) elemProcess.attr('data-code', value);
    }

    function collectProcessCodeUpdatesBeforeSave() {
        let updatesByLink = new Map();
        let assignedCodesByLink = new Map();
        let conflicts = [];

        $('#mbom .item-bom').each(function() {
            let elemBOM = $(this);
            let elemProcesses = elemBOM.children('.item.process');
            if(elemProcesses.length === 0) return;

            let reservedCodes = new Set();
            let seenCodes = new Set();
            let processedEdges = new Set();
            let highestCode = 0;

            elemProcesses.each(function() {
                let code = parseProcessSequenceCode(getProcessCodeFromElement($(this)));
                if(Number.isNaN(code)) return;

                reservedCodes.add(code);
                if(code > highestCode) highestCode = code;
            });

            let nextCode = (Math.floor(highestCode / 10) + 1) * 10;
            if(nextCode < 10) nextCode = 10;

            elemProcesses.each(function() {
                let elemProcess = $(this);
                let edgeId = elemProcess.attr('data-edge') || '';

                // Ignore a duplicate DOM rendering of the same saved edge.
                if(!isBlank(edgeId) && processedEdges.has(edgeId)) return;
                if(!isBlank(edgeId)) processedEdges.add(edgeId);

                let originalValue = getProcessCodeFromElement(elemProcess);
                let parsedCode = parseProcessSequenceCode(originalValue);
                let desiredCode = parsedCode;

                if(Number.isNaN(parsedCode) || seenCodes.has(parsedCode)) {
                    while(reservedCodes.has(nextCode)) nextCode += 10;
                    desiredCode = nextCode;
                    reservedCodes.add(desiredCode);
                    nextCode += 10;
                }

                seenCodes.add(desiredCode);

                let processLink = getPLMItemLevelLink(elemProcess.attr('data-link') || '');
                let codeChanged = Number.isNaN(parsedCode) || desiredCode !== parsedCode;

                if(!isBlank(processLink)) {
                    let normalizedLink = normalizePLMLink(processLink);
                    let assignedCode = assignedCodesByLink.get(normalizedLink);

                    if(typeof assignedCode !== 'undefined' && assignedCode !== desiredCode) {
                        conflicts.push({
                            link        : processLink,
                            firstCode   : assignedCode,
                            secondCode  : desiredCode,
                            description : getERPTechnologyDescriptor(elemProcess)
                        });
                        return;
                    }

                    assignedCodesByLink.set(normalizedLink, desiredCode);
                }

                if(!codeChanged) return;

                setProcessCodeDisplay(elemProcess, desiredCode, isBlank(processLink));

                if(isBlank(processLink)) return;

                let normalizedLink = normalizePLMLink(processLink);
                let existingUpdate = updatesByLink.get(normalizedLink);

                if(existingUpdate && existingUpdate.code !== desiredCode) {
                    conflicts.push({
                        link        : processLink,
                        firstCode   : existingUpdate.code,
                        secondCode  : desiredCode,
                        description : getERPTechnologyDescriptor(elemProcess)
                    });
                    return;
                }

                if(!existingUpdate) {
                    updatesByLink.set(normalizedLink, {
                        link    : processLink,
                        code    : desiredCode,
                        element : elemProcess
                    });
                }
            });
        });

        return {
            updates   : Array.from(updatesByLink.values()),
            conflicts : conflicts
        };
    }

    function normalizeProcessCodesBeforeSave() {
        let result = collectProcessCodeUpdatesBeforeSave();

        if(result.conflicts.length > 0) {
            console.warn('MBOM custom: process code normalization found reused process items with conflicting local codes', result.conflicts);
            return Promise.reject(new Error('The same process item is used with conflicting codes in multiple subassemblies.'));
        }

        if(result.updates.length === 0) {
            console.log('MBOM custom: process code validation finished without PLM updates');
            return Promise.resolve();
        }

        console.log('MBOM custom: updating normalized process codes before save', result.updates.map(function(update) {
            return {
                link : update.link,
                code : update.code
            };
        }));

        let requests = result.updates.map(function(update) {
            return $.post('/plm/edit', {
                link     : update.link,
                sections : wsMBOM.sections,
                fields   : [{
                    fieldId : config.workspaceMBOM.fieldIDs.code,
                    value   : update.code
                }]
            }).then(function(response) {
                if(response && response.error) {
                    throw new Error(response.message || ('PLM rejected process code ' + update.code + '.'));
                }

                $('#mbom .item.process').each(function() {
                    let elemProcess = $(this);
                    if(normalizePLMLink(elemProcess.attr('data-link')) === normalizePLMLink(update.link)) {
                        setProcessCodeDisplay(elemProcess, update.code, true);
                    }
                });
            });
        });

        return Promise.all(requests).then(function() {
            erpTechnologyDetailsCache = {};
            console.log('MBOM custom: process code normalization completed', {
                updatedItems : result.updates.length
            });
        });
    }

    function getAssemblyIndexItemsForPropertySave() {
        let itemsByLink = new Map();

        $('#mbom .item').each(function() {
            let elemItem = $(this);
            let descriptor = getERPTechnologyDescriptor(elemItem);
            let isAssemblyIndex = elemItem.hasClass('assembly-index') || hasAssemblyIndexTitle({ title : descriptor });
            if(!isAssemblyIndex) return;

            let itemLink = getPLMItemLevelLink(getMBOMSaveLink(elemItem));
            let normalizedLink = normalizePLMLink(itemLink);
            if(isBlank(normalizedLink) || itemsByLink.has(normalizedLink)) return;

            itemsByLink.set(normalizedLink, {
                link       : itemLink,
                descriptor : descriptor
            });
        });

        return Array.from(itemsByLink.values());
    }

    function saveAssemblyIndexPropertiesBeforeSave() {
        let assemblyIndexItems = getAssemblyIndexItemsForPropertySave();
        if(assemblyIndexItems.length === 0) return Promise.resolve();

        console.log('MBOM custom: saving assembly index PLM properties before BOM save', assemblyIndexItems);

        let requests = assemblyIndexItems.map(function(item) {
            return $.post('/plm/edit', {
                link     : item.link,
                sections : wsMBOM.sections,
                fields   : [{
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
            }).then(function(response) {
                if(response && response.error) {
                    throw new Error(response.message || ('PLM rejected assembly index property update for ' + item.descriptor + '.'));
                }
            });
        });

        return Promise.all(requests).then(function() {
            erpTechnologyDetailsCache = {};
            console.log('MBOM custom: assembly index PLM properties saved', {
                updatedItems : assemblyIndexItems.length,
                specification: assemblyIndexPLMDefaults.specification
            });
        });
    }

    async function saveMBOMHasBOMMarker(link) {
        let details = await loadMBOMPropertyRepairDetails(link, 'mBOM');
        let sourceLink = getMBOMPropertyRepairSourceLink(details);
        if(isBlank(sourceLink) || !isMBOMPropertyRepairTarget(details, link, sourceLink)) return;
        let hasBom = await getSourceEBOMHasChildren({ __self__: sourceLink });
        let savedValue = getSectionFieldValue(details.sections || [], 'HAS_BOM', null);
        if(savedValue !== null && typeof savedValue !== 'undefined' && savedValue !== '' && isMBOMHasBOM(savedValue) === hasBom) return;
        let response = await $.post('/plm/edit', {
            link: link, sections: wsMBOM.sections,
            fields: [{ fieldId: 'HAS_BOM', value: hasBom }]
        });
        if(!response || response.error) {
            throw new Error('Could not save HAS_BOM for ' + link + '. ' + getRawMaterialErrorMessage(response));
        }
    }

    async function saveMBOMHasBOMMarkersBeforeSave() {
        let linksToUpdate = new Set();
        $('#mbom .item').each(function() {
            let elemItem = $(this);
            if(!isMBOMTechnologyItem(elemItem)) return;
            let link = getPLMItemLevelLink(getMBOMSaveLink(elemItem));
            if(!isBlank(link)) linksToUpdate.add(link);
        });
        let pendingLinks = Array.from(linksToUpdate);
        let batchSize = Math.max(1, Math.min(5, typeof maxRequests === 'number' ? maxRequests : 5));
        let started = Date.now();
        for(let offset = 0; offset < pendingLinks.length; offset += batchSize) {
            let results = await Promise.allSettled(pendingLinks.slice(offset, offset + batchSize).map(saveMBOMHasBOMMarker));
            let failure = results.find(function(result) { return result.status === 'rejected'; });
            if(failure) throw failure.reason;
        }
        console.log('MBOM custom: HAS_BOM checks completed', { items: pendingLinks.length, durationMs: Date.now() - started });
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

            syncExistingBOMStateBeforeSave(headers).then(function() {
                completeSaveCheckDialog(headers.length);
                startSaveProcessStep();
                return saveAssemblyIndexPropertiesBeforeSave();
            }).then(function() {
                updateSaveProcessStep(1);
                return normalizeProcessCodesBeforeSave();
            }).then(function() {
                updateSaveProcessStep(2);
                return loadMBOMOperationTypeValue();
            }).then(function() {
                completeSaveProcessStep();
                setSaveActions();
                showSaveProcessingDialog();
                createNewItems();
            }).catch(function(error) {
                console.warn('MBOM custom: failed to validate BOM state or process codes before save', error);
                showErrorMessage('Error while preparing save', String(error && error.message ? error.message : 'Could not validate existing BOM entries before saving.'));
                elemButton.removeClass('disabled');
                $('#confirm-saving').removeClass('disabled').addClass('default');
            });
        });
    }

    if(typeof endProcessing === 'function') {
        let originalEndProcessing = endProcessing;
        endProcessing = function() {
            try {
                return originalEndProcessing.apply(this, arguments);
            } finally {
                $('#save').removeClass('disabled');
            }
        };
    }

    if(typeof showSaveProcessingDialog === 'function') {
        let originalShowSaveProcessingDialog = showSaveProcessingDialog;
        showSaveProcessingDialog = function() {
            let checkFinished = $('#step-counter0').length > 0 && !$('#step0').hasClass('in-work');
            let processFinished = $('#step-counter-process').length > 0 && !$('#step-process').hasClass('in-work');

            originalShowSaveProcessingDialog.apply(this, arguments);

            if(checkFinished) {
                $('#step-bar0').addClass('transition-stopper').css('width', '100%').removeClass('transition-stopper');
            }
            if(processFinished) {
                $('#step-bar-process').addClass('transition-stopper').css('width', '100%').removeClass('transition-stopper');
                $('#step-counter-process').html('3 of 3');
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

    function hasAssemblyIndexTitle(node) {
        if(!node) return false;

        let title = String(node.title || '').trim().toLowerCase();
        return title.indexOf('indeks złożeniowy ') === 0 ||
            title.indexOf('indeks zlozeniowy ') === 0;
    }

    function isAssemblyIndexNode(node) {
        if(!node) return false;
        if(node.isAssemblyIndex) return true;

        // A directly opened assembly index is the MBOM root and has level 0.
        return hasAssemblyIndexTitle(node);
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

    function fetchInlineSubMBOMChildren(part, linkOverride, isAssemblyIndex, depthOverride) {
        let primaryLink = linkOverride || part.link;
        let requestDepth = Number(depthOverride);
        if(!Number.isFinite(requestDepth) || requestDepth < 1) requestDepth = getCustomMBOMDepth();
        let requestsToTry = [];
        let requestKeys = new Set();

        function addLinkCandidate(link) {
            if(isBlank(link)) return;

            let key = 'link:' + String(link);
            if(requestKeys.has(key)) return;

            requestKeys.add(key);
            requestsToTry.push({ link : link });
        }

        function addItemIdCandidate(link) {
            if(isBlank(link)) return;

            let match = String(link).match(/\/api\/v3\/workspaces\/(\d+)\/items\/(\d+)/i);
            if(!match) return;

            let key = 'item:' + match[1] + ':' + match[2];
            if(requestKeys.has(key)) return;

            requestKeys.add(key);
            requestsToTry.push({
                wsId  : match[1],
                dmsId : match[2]
            });
        }

        // Preserve the link that worked before as the primary request. An
        // assembly-index edge can point at an older version, so retry the
        // item-level working BOM only when the primary BOM has no children.
        addLinkCandidate(primaryLink);
        if(isAssemblyIndex || (part && part.isAssemblyIndex)) {
            addLinkCandidate(part ? part.link : '');
            addLinkCandidate(getPLMItemLevelLink(primaryLink));
            addLinkCandidate(getPLMItemLevelLink(part ? part.link : ''));
            addItemIdCandidate(primaryLink);
            addItemIdCandidate(part ? part.link : '');
        }

        function fetchCandidate(candidateIndex, previousError) {
            if(candidateIndex >= requestsToTry.length) {
                if(previousError) throw previousError;
                return [];
            }

            let candidate = requestsToTry[candidateIndex];
            let params = {
                viewId          : wsMBOM.viewId,
                depth           : requestDepth,
                revisionBias    : 'working',
                getBOMPartsList : true
            };

            if(!isBlank(candidate.link)) {
                params.link = candidate.link;
            } else {
                params.wsId = candidate.wsId;
                params.dmsId = candidate.dmsId;
            }

            let requestLink = params.link || ('/api/v3/workspaces/' + params.wsId + '/items/' + params.dmsId);

            return $.ajax({
                url    : '/plm/bom',
                method : 'GET',
                data   : params,
                cache  : false
            }).then(function(response) {
                let parts = response && response.data && Array.isArray(response.data.bomPartsList) ? response.data.bomPartsList : [];
                console.info('MBOM custom: inline sub-MBOM fetch result', {
                    link       : requestLink,
                    attempt    : candidateIndex + 1,
                    depth      : requestDepth,
                    partsCount : parts.length,
                    edgesCount : response && response.data && Array.isArray(response.data.edges) ? response.data.edges.length : 0,
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

                console.info('MBOM custom: expanded inline sub-MBOM for', requestLink, 'with', children.length, 'child item(s).');
                return children;
            }, function(error) {
                console.warn('MBOM custom: failed inline sub-MBOM link candidate', requestLink, error);
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
            let link = elemItem.attr('data-linked-mbom') || elemItem.attr('data-mbom') || elemItem.attr('data-link-mbom') || elemItem.attr('data-link');
            if(!isBlank(link)) return link;
        }
        return part ? part.link : '';
    }

    function getConfiguredMBOMLinkFromDetails(detailsData) {
        let sections = detailsData && Array.isArray(detailsData.sections) ? detailsData.sections : [];
        let fieldIds = [];

        function addFieldId(fieldId) {
            if(isBlank(fieldId) || fieldIds.indexOf(fieldId) >= 0) return;
            fieldIds.push(fieldId);
        }

        let configuredFieldId = (typeof config !== 'undefined' && config.workspaceEBOM && config.workspaceEBOM.fieldIDs)
            ? config.workspaceEBOM.fieldIDs.mbom
            : '';
        let contextFieldId = (typeof urlParameters !== 'undefined')
            ? urlParameters.contextfieldidmbom
            : '';
        let suffix = (typeof siteSuffix !== 'undefined') ? siteSuffix : '';

        if(!isBlank(contextFieldId) && !isBlank(suffix)) addFieldId(contextFieldId + suffix);
        addFieldId(contextFieldId);
        if(!isBlank(configuredFieldId) && !isBlank(suffix)) addFieldId(configuredFieldId + suffix);
        addFieldId(configuredFieldId);

        for(let fieldId of fieldIds) {
            let link = getSectionFieldValue(sections, fieldId, '', 'link');
            if(!isBlank(link)) return link;
        }

        return '';
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

        if(elemItem && elemItem.length > 0 && elemItem.hasClass('assembly-index')) {
            let fallbackPart = part || {
                link  : elemItem.attr('data-link'),
                root  : elemItem.attr('data-root'),
                level : getElementLevel(elemItem)
            };
            let sourceLink = getPLMItemLevelLink(elemItem.attr('data-link') || fallbackPart.link);
            let cachedLink = elemItem.attr('data-linked-mbom') || '';

            if(!isBlank(cachedLink)) {
                return Promise.resolve({
                    part          : fallbackPart,
                    expansionLink : cachedLink
                });
            }

            if(isBlank(sourceLink)) {
                return Promise.resolve({
                    part          : fallbackPart,
                    expansionLink : getInlineSubMBOMLink(elemItem, fallbackPart)
                });
            }

            return $.ajax({
                url    : '/plm/details',
                method : 'GET',
                data   : { link : sourceLink },
                cache  : false
            }).then(function(response) {
                let linkedMBOM = getConfiguredMBOMLinkFromDetails(response && response.data ? response.data : null);
                let expansionLink = isBlank(linkedMBOM) ? sourceLink : linkedMBOM;

                elemItem.attr('data-linked-mbom', expansionLink);

                console.log('MBOM custom: resolved assembly index BOM source', {
                    assemblyIndexLink : sourceLink,
                    expansionLink     : expansionLink,
                    selfContained     : normalizePLMLink(sourceLink) === normalizePLMLink(expansionLink)
                });

                return {
                    part          : fallbackPart,
                    expansionLink : expansionLink
                };
            }).catch(function(error) {
                console.warn('MBOM custom: failed to resolve assembly index MBOM link, using the index itself', {
                    assemblyIndexLink : sourceLink,
                    error             : error
                });

                return {
                    part          : fallbackPart,
                    expansionLink : sourceLink
                };
            });
        }

        // The MBOM part/link is sufficient for expanding its manufacturing
        // structure. Do not round-trip through the related EBOM item.
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
        let hasShortcutIcons = elemToggle.children('.mbom-shortcut.inline-submbom-toggle').length > 0;
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
        let elemNode = findMatchingDirectInlineChild(elemParent, node);
        if(elemNode.length === 0) elemNode = insertBOMPartListNode('mbom', null, renderNode).appendTo(elemParent)
            .addClass('inline-submbom-injected')
            .attr('data-edge', node.edgeId || '')
            .attr('data-link-db', node.link || '')
            .attr('data-number-db', node.number || '')
            .attr('data-qty', node.quantity || 0);

        if(!node.hasChildren) return elemNode;

        let elemNodeBOM = ensureInlineSubMBOMContainer(elemNode);
        let nextLevel = node.level + 1;
        let nextIndex = startIndex + 1;
        let directChildEdgeIds = [];

        while(nextIndex < parts.length) {
            if(parts[nextIndex].level < nextLevel) break;

            if(parts[nextIndex].level === nextLevel) {
                renderInlineSubMBOMBranch(elemNodeBOM, parts, nextIndex);
                if(!isBlank(parts[nextIndex].edgeId)) directChildEdgeIds.push(parts[nextIndex].edgeId);
            }

            nextIndex++;
        }

        mergeParentEdgeIds(elemNode.children('.item-head').first(), directChildEdgeIds);

        return elemNode;
    }

    function findMatchingDirectInlineChild(elemBOM, childPart) {
        if(!elemBOM || elemBOM.length === 0 || !childPart) return $();

        let normalizedLink = normalizePLMLink(childPart.link);
        let edgeId = isBlank(childPart.edgeId) ? '' : String(childPart.edgeId);
        let number = isBlank(childPart.number) ? '' : String(childPart.number);
        let found = $();

        elemBOM.children('.item').each(function() {
            let elemChild = $(this);
            let childEdgeId = elemChild.attr('data-edge') || '';
            let childLink = normalizePLMLink(elemChild.attr('data-link'));
            let childNumber = elemChild.attr('data-number-db') || elemChild.attr('data-number') || '';

            if(!isBlank(edgeId) && childEdgeId === edgeId) {
                found = elemChild;
                return false;
            }

            // Different saved relationships may legitimately use the same operation item.
            if(!isBlank(edgeId) && !isBlank(childEdgeId)) return;
            if(!isBlank(normalizedLink) && childLink === normalizedLink && String(childNumber) === number) {
                found = elemChild;
                return false;
            }
        });

        return found;
    }

    function appendInlineSubMBOMChildren(elemItem, children) {
        mergeRawMaterialPartsIntoList(children);

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
        let directChildEdgeIds = [];
        while(index < children.length) {
            if(children[index].level === children[0].level) {
                renderInlineSubMBOMBranch(elemBOM, children, index);
                if(!isBlank(children[index].edgeId)) directChildEdgeIds.push(children[index].edgeId);
            }
            index++;
        }

        mergeParentEdgeIds(elemItem.children('.item-head').first(), directChildEdgeIds);

        if(!inlineSubMBOMBulkExpansionActive) {
            updateMBOMNumbers();
            if(typeof setStatusBar === 'function') setStatusBar();
        }
    }

    function setInlineSubMBOMToggleState(elemItem, expanded) {
        if(!elemItem || elemItem.length === 0) return;

        let elemInlineToggle = elemItem.children('.item-head').children('.item-toggle').first()
            .children('.inline-submbom-toggle').first();
        if(elemInlineToggle.length === 0) return;

        elemInlineToggle
            .removeClass('icon-expand icon-collapse icon-radio-checked icon-radio-unchecked')
            .addClass(expanded ? 'icon-collapse' : 'icon-expand')
            .attr('title', expanded ? 'Collapse the linked sub-MBOM' : 'Expand the linked sub-MBOM');
    }

    function toggleInlineSubMBOM(elemItem) {
        let elemToggle = elemItem.children('.item-head').children('.item-toggle').first();
        let elemBOM = elemItem.children('.item-bom').first();

        if(elemToggle.hasClass('icon-collapse') || elemToggle.hasClass('icon-expand')) {
            elemToggle.toggleClass('icon-collapse').toggleClass('icon-expand');
        }

        elemBOM.toggleClass('hidden');
        setInlineSubMBOMToggleState(elemItem, !elemBOM.hasClass('hidden'));
    }

    function ensureInlineSubMBOMExpanded(elemItem, depthOverride) {
        if(!elemItem || elemItem.length === 0) return Promise.resolve(false);

        let requestedDepth = Number(depthOverride);
        if(!Number.isFinite(requestedDepth) || requestedDepth < 1) requestedDepth = getCustomMBOMDepth();
        let loadedDepth = Number(elemItem.attr('data-inline-submbom-depth'));
        let loadedDepthSatisfiesRequest = !Number.isFinite(loadedDepth) || loadedDepth >= requestedDepth;

        if(elemItem.attr('data-inline-submbom-loaded') === 'true' && loadedDepthSatisfiesRequest) {
            let elemBOM = ensureInlineSubMBOMContainer(elemItem);
            elemBOM.removeClass('hidden');

            let elemToggle = elemItem.children('.item-head').children('.item-toggle').first();
            if(elemToggle.hasClass('icon-expand')) {
                elemToggle.removeClass('icon-expand').addClass('icon-collapse');
            }
            setInlineSubMBOMToggleState(elemItem, true);
            completeLinkedEBOMBOMCheckForMBOM(elemItem);
            if(!inlineSubMBOMBulkExpansionActive && typeof setStatusBar === 'function') setStatusBar();

            return Promise.resolve(true);
        }

        let elemExistingBOM = elemItem.children('.item-bom').first();
        if(elemItem.attr('data-inline-submbom-loaded') !== 'true' &&
           elemItem.hasClass('assembly-index') &&
           elemExistingBOM.children('.item').length > 0) {
            elemExistingBOM.children('.inline-submbom-status').remove();
            elemExistingBOM.removeClass('hidden');
            elemItem.attr('data-inline-submbom-loaded', 'true');
            elemItem.attr('data-inline-submbom-depth', getCustomMBOMDepth());
            setInlineSubMBOMToggleState(elemItem, true);
            completeLinkedEBOMBOMCheckForMBOM(elemItem);

            console.info('MBOM custom: reusing sub-MBOM children already rendered by the main BOM response', {
                link       : elemItem.attr('data-link'),
                childCount : elemExistingBOM.children('.item').length
            });

            if(!inlineSubMBOMBulkExpansionActive && typeof setStatusBar === 'function') setStatusBar();
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
                level           : part.level,
                depth           : requestedDepth
            });

            return fetchInlineSubMBOMChildren(part, expansionLink, elemItem.hasClass('assembly-index'), requestedDepth).then(function(children) {
                $('#overlay').hide();

                if(children.length === 0) {
                    console.info('MBOM custom: no inline sub-MBOM children found for', expansionLink);
                    elemItem.attr('data-inline-submbom-loaded', 'empty');
                    elemItem.attr('data-inline-submbom-depth', requestedDepth);
                    setInlineSubMBOMStatus(elemItem, 'No sub-MBOM children were returned for this item.', true);
                    setInlineSubMBOMToggleState(elemItem, false);
                    return false;
                }

                console.info('MBOM custom: rendering inline sub-MBOM children', {
                    expansionLink : expansionLink,
                    childCount    : children.length,
                    firstLevel    : children[0].level
                });

                appendInlineSubMBOMChildren(elemItem, children);
                elemItem.attr('data-inline-submbom-loaded', 'true');
                elemItem.attr('data-inline-submbom-depth', requestedDepth);
                setInlineSubMBOMToggleState(elemItem, true);
                completeLinkedEBOMBOMCheckForMBOM(elemItem);
                if(!inlineSubMBOMBulkExpansionActive && typeof setStatusBar === 'function') setStatusBar();
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
        let elemMBOMItem = getMBOMItemForPart(part);
        if(!elemMBOMItem || elemMBOMItem.length === 0) {
            console.warn('MBOM custom: could not prepare raw material branch because the MBOM source item was not found', {
                mbomLink   : getPartItemLink(part),
                material   : getMaterialValue(part),
                partNumber : getPartNumber(part)
            });
            return Promise.resolve($());
        }

        let hasDirectProcessChild = getFirstDirectProcessChildHeader(elemMBOMItem).length > 0;
        if(hasDirectProcessChild) {
            console.log('MBOM custom: MBOM source item already has a direct process child in DOM', {
                mbomLink   : getPartItemLink(part),
                targetItem : describeMBOMItem(elemMBOMItem)
            });
            return Promise.resolve(elemMBOMItem);
        }

        if(elemMBOMItem.hasClass('process') && !isMBOMTechnologyItem(elemMBOMItem)) {
            console.log('MBOM custom: MBOM source item is a process node without child process nodes, no expansion needed', {
                mbomLink   : getPartItemLink(part),
                targetItem : describeMBOMItem(elemMBOMItem)
            });
            return Promise.resolve(elemMBOMItem);
        }

        if(!hasMBOMShortcut(elemMBOMItem)) {
            console.log('MBOM custom: MBOM source item has no inline sub-MBOM shortcut, using current node as-is', {
                mbomLink   : getPartItemLink(part),
                targetItem : describeMBOMItem(elemMBOMItem)
            });
            return Promise.resolve(elemMBOMItem);
        }

        console.log('MBOM custom: expanding MBOM source item to find direct process child target', {
            mbomLink   : getPartItemLink(part),
            targetItem : describeMBOMItem(elemMBOMItem)
        });

        return ensureInlineSubMBOMExpanded(elemMBOMItem).then(function() {
            console.log('MBOM custom: MBOM source item expansion finished', {
                mbomLink         : getPartItemLink(part),
                targetItem       : describeMBOMItem(elemMBOMItem),
                processChildFound: getFirstDirectProcessChildHeader(elemMBOMItem).length > 0
            });
            return elemMBOMItem;
        });
    }

    function ensureRawMaterialFallbackProcess(part) {
        let elemMBOMItem = getMBOMItemForPart(part);
        if(!elemMBOMItem || elemMBOMItem.length === 0) return Promise.resolve($());

        let elemExistingHeader = getRawMaterialTargetHeader(part);
        if(elemExistingHeader.length > 0) return Promise.resolve(elemExistingHeader);

        let pendingPromise = elemMBOMItem.data('raw-material-process-promise');
        if(pendingPromise) return pendingPromise;

        pendingPromise = loadAddProcessWorkspaceItems().then(function(items) {
            let elemHeader = getRawMaterialTargetHeader(part);
            if(elemHeader.length > 0) return elemHeader;

            let processItem = findAddProcessWorkspaceItemByName(items, rawMaterialFallbackProcessName);
            if(!processItem) {
                throw new Error('Operation "' + rawMaterialFallbackProcessName +
                    '" was not found in workspace ' + addProcessWorkspaceId + '.');
            }

            let elemProcess = insertWorkspaceProcessItem(
                processItem,
                elemMBOMItem,
                rawMaterialFallbackProcessName
            );
            if(elemProcess.length === 0) {
                throw new Error('Operation "' + rawMaterialFallbackProcessName +
                    '" could not be inserted below the target mBOM.');
            }

            let elemProcessHeader = elemProcess.children('.item-head').first();
            ensureInlineSubMBOMContainer(elemProcess);

            console.log('MBOM custom: added fallback operation for raw material', {
                operation  : getAddProcessItemTitle(processItem) || rawMaterialFallbackProcessName,
                mbomLink   : getPartItemLink(part),
                targetItem : describeMBOMItem(elemMBOMItem)
            });

            return elemProcessHeader;
        }).then(function(elemProcessHeader) {
            elemMBOMItem.removeData('raw-material-process-promise');
            return elemProcessHeader;
        }).catch(function(error) {
            elemMBOMItem.removeData('raw-material-process-promise');
            throw error;
        });

        elemMBOMItem.data('raw-material-process-promise', pendingPromise);
        return pendingPromise;
    }

    function markRawMaterialStructureDirty() {
        rawMaterialStructureDirty = true;
        rawMaterialDetailsPromises = {};
    }

    function getRawMaterialPartKey(part) {
        if(!part) return '';
        let link = normalizePLMLink(getPartItemLink(part));
        let root = normalizePLMLink(part.root || '');
        return link + '|' + root;
    }

    function mergeRawMaterialPartsIntoList(parts) {
        if(!Array.isArray(parts) || parts.length === 0) return;
        if(!Array.isArray(mbomPartsList)) mbomPartsList = [];

        let existing = new Set(mbomPartsList.map(getRawMaterialPartKey));
        parts.forEach(function(part) {
            let key = getRawMaterialPartKey(part);
            if(isBlank(key) || existing.has(key)) return;
            mbomPartsList.push(part);
            existing.add(key);
        });
    }

    function refreshRawMaterialPartsListIfNeeded() {
        if(!rawMaterialStructureDirty) return Promise.resolve(mbomPartsList);
        if(rawMaterialStructureRefreshPromise) return rawMaterialStructureRefreshPromise;

        let rootItem = $('#mbom-tree').children('.item').first();
        let mbomLink = (typeof links !== 'undefined' && links && !isBlank(links.mbom))
            ? links.mbom
            : getMBOMSaveLink(rootItem);

        if(isBlank(mbomLink)) return Promise.resolve(mbomPartsList);

        let params = {
            link            : mbomLink,
            viewId          : wsMBOM.viewId,
            depth           : getCustomMBOMDepth(),
            revisionBias    : 'working',
            getBOMPartsList : true
        };

        console.log('MBOM custom: refreshing MBOM parts after structural save for raw material discovery', params);

        rawMaterialStructureRefreshPromise = $.ajax({
            url    : '/plm/bom',
            method : 'GET',
            data   : params,
            cache  : false
        }).then(function(response) {
            let refreshedParts = response && response.data && Array.isArray(response.data.bomPartsList)
                ? response.data.bomPartsList
                : [];
            if(refreshedParts.length === 0) {
                throw new Error('The refreshed MBOM did not return a parts list.');
            }

            mbomPartsList = refreshedParts;
            refreshMBOMHierarchyFlags();
            rawMaterialStructureDirty = false;

            console.log('MBOM custom: refreshed raw material MBOM source list', {
                parts: mbomPartsList.length
            });
            return mbomPartsList;
        }).catch(function(error) {
            console.warn('MBOM custom: could not refresh the MBOM source list; continuing with the current editor structure', error);
            return mbomPartsList;
        }).then(function(parts) {
            rawMaterialStructureRefreshPromise = null;
            return parts;
        });

        return rawMaterialStructureRefreshPromise;
    }

    function getRawMaterialDOMSourceParts() {
        let parts = [];

        $('#mbom-tree').find('.item').each(function() {
            let elemItem = $(this);
            if(!isMBOMTechnologyItem(elemItem)) return;

            let existingPart = getMBOMPartFromElement(elemItem);
            if(existingPart) {
                parts.push(existingPart);
                return;
            }

            let link = getERPTechnologyElementLink(elemItem);
            if(isBlank(link)) return;

            parts.push({
                link   : link,
                root   : elemItem.attr('data-root') || link,
                level  : getElementLevel(elemItem),
                edgeId : elemItem.attr('data-edge') || '',
                details: {
                    NUMBER: elemItem.attr('data-part-number') || ''
                }
            });
        });

        return parts;
    }

    async function ensureRawMaterialTreeExpanded() {
        let processed = new Set();
        let ownsBulkExpansion = !inlineSubMBOMBulkExpansionActive;
        if(ownsBulkExpansion) inlineSubMBOMBulkExpansionActive = true;

        try {
            while(true) {
                // Reuse ERP's expandable-item discovery, but include ERP-synced MBOMs too.
                let candidates = getERPTechnologyExpandableItems().filter(function(elemItem) {
                    let key = getERPTechnologyElementLink(elemItem) || elemItem[0];
                    return !processed.has(key);
                });
                if(candidates.length === 0) return;

                let nextCandidate = 0;
                let workerCount = Math.min(6, candidates.length);
                let workers = [];

                async function expandNextCandidate() {
                    while(nextCandidate < candidates.length) {
                        let elemItem = candidates[nextCandidate++];
                        let link = getERPTechnologyElementLink(elemItem);
                        processed.add(link || elemItem[0]);
                        let expanded = await ensureInlineSubMBOMExpanded(elemItem);
                        $('#overlay').show();
                        if(!expanded && elemItem.attr('data-inline-submbom-loaded') !== 'empty') {
                            throw new Error('Could not discover all nested MBOMs below ' + (link || 'an unsaved item') + '. Retry after this branch has loaded.');
                        }
                    }
                }

                for(let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
                    workers.push(expandNextCandidate());
                }
                await Promise.all(workers);
            }
        } finally {
            if(ownsBulkExpansion) {
                inlineSubMBOMBulkExpansionActive = false;
                if(typeof updateMBOMNumbers === 'function') updateMBOMNumbers();
                if(typeof setStatusBar === 'function') setStatusBar();
            }
        }
    }

    function filterRawMaterialEntriesWithMaterial(entries) {
        let sourceEntries = Array.isArray(entries) ? entries : [];
        let applicableEntries = sourceEntries.filter(function(entry) {
            return entry && !isBlank(entry.material);
        });
        let skipped = sourceEntries.length - applicableEntries.length;

        if(skipped > 0) {
            console.log('MBOM custom: skipped MBOM raw material sources with empty MATERIAL', {
                skipped   : skipped,
                applicable: applicableEntries.length
            });
        }

        return applicableEntries;
    }

    function hasRawMaterialsBOMColumn(part, fieldId) {
        if(!part || !part.details) return false;
        let normalizedFieldId = String(fieldId).toLowerCase().replace(/[^a-z0-9]/g, '');
        return Object.keys(part.details).some(function(candidate) {
            return String(candidate).toLowerCase().replace(/[^a-z0-9]/g, '') === normalizedFieldId;
        });
    }

    function validateRawMaterialsBOMColumns(parts) {
        let firstPart = parts[0] || null;
        let fieldIds = config.workspaceMBOM.fieldIDs || {};
        let requiredColumns = [
            fieldIds.number || 'NUMBER',
            fieldIds.type || 'TYPE',
            'HAS_BOM',
            'MATERIAL',
            rawMaterialAccountingUnitFieldId,
            rawMaterialAccountingQuantityFieldId,
            rawMaterialProductGroupFieldId
        ];
        let missing = requiredColumns.filter(function(fieldId) {
            return !hasRawMaterialsBOMColumn(firstPart, fieldId);
        });

        if(missing.length > 0) {
            throw new Error('W widoku BOM „' + rawMaterialsBOMViewName + '” brakuje wymaganych kolumn: ' + missing.join(', ') + '.');
        }
    }

    function getRawMaterialsBOMView() {
        if(!rawMaterialsBOMViewPromise) {
            rawMaterialsBOMViewPromise = $.get('/plm/bom-view-by-name', {
                wsId     : wsMBOM.wsId,
                name     : rawMaterialsBOMViewName,
                useCache : true
            }).then(function(response) {
                let view = response && response.data ? response.data : null;
                if(!view || isBlank(view.id)) {
                    throw new Error('Nie znaleziono widoku BOM „' + rawMaterialsBOMViewName + '”.');
                }
                return view;
            }).catch(function(error) {
                rawMaterialsBOMViewPromise = null;
                throw error;
            });
        }

        return rawMaterialsBOMViewPromise;
    }

    function loadRawMaterialsBOMParts() {
        let rootItem = $('#mbom-tree').children('.item').first();
        let mbomLink = (typeof links !== 'undefined' && links && !isBlank(links.mbom))
            ? links.mbom
            : getMBOMSaveLink(rootItem);
        if(isBlank(mbomLink)) return Promise.reject(new Error('Nie znaleziono zapisanego mBOM do wyszukania surowców.'));

        return getRawMaterialsBOMView().then(function(view) {
            return $.get('/plm/bom', {
                link            : mbomLink,
                viewId          : view.id,
                depth           : getCustomMBOMDepth(),
                revisionBias    : 'working',
                getBOMPartsList : true
            });
        }).then(function(response) {
            let parts = response && response.data && Array.isArray(response.data.bomPartsList)
                ? response.data.bomPartsList
                : [];
            if(parts.length === 0) {
                throw new Error('Widok BOM „' + rawMaterialsBOMViewName + '” nie zwrócił żadnych elementów.');
            }
            validateRawMaterialsBOMColumns(parts);
            return parts;
        });
    }

    function isRawMaterialsBOMSourcePart(part) {
        let fieldIds = config.workspaceMBOM.fieldIDs || {};
        let type = getMBOMAccountingFieldValue(part, fieldIds.type || 'TYPE');
        return String(type || '').trim().toLowerCase() === 'manufacturing';
    }

    function getRawMaterialAssignmentsByMBOM(parts) {
        let assignments = new Map();
        let manufacturingStack = [];
        let fieldIds = config.workspaceMBOM.fieldIDs || {};

        (Array.isArray(parts) ? parts : []).forEach(function(part) {
            let level = Number(part && part.level);
            if(Number.isNaN(level)) level = 0;

            while(manufacturingStack.length > 0 &&
                manufacturingStack[manufacturingStack.length - 1].level >= level) {
                manufacturingStack.pop();
            }

            let type = normalizeComparisonValue(
                getMBOMAccountingFieldValue(part, fieldIds.type || 'TYPE')
            );
            let link = getPLMItemLevelLink(getPartItemLink(part));
            let key = normalizePLMLink(link);

            if(type === 'manufacturing') {
                if(!isBlank(key)) {
                    if(!assignments.has(key)) assignments.set(key, new Set());
                    manufacturingStack.push({ level : level, key : key });
                }
                return;
            }

            if(type !== normalizeComparisonValue(rawMaterialTypeName) || isBlank(key) || manufacturingStack.length === 0) return;
            assignments.get(manufacturingStack[manufacturingStack.length - 1].key).add(normalizePLMVersionLink(link));
        });

        return assignments;
    }

    function resolveRawMaterialsBOMViewParts(parts) {
        let sourceParts = [];
        let seen = new Set();
        let assignments = getRawMaterialAssignmentsByMBOM(parts);

        parts.forEach(function(part) {
            if(!isRawMaterialsBOMSourcePart(part)) return;
            let key = normalizePLMLink(getPartItemLink(part));
            if(!isBlank(key) && seen.has(key)) return;
            if(!isBlank(key)) seen.add(key);
            sourceParts.push(part);
        });

        console.log('MBOM custom: raw material sources loaded from one Raw Materials BOM response', {
            parts     : parts.length,
            mbomRoots : sourceParts.length
        });

        return filterRawMaterialEntriesWithMaterial(sourceParts.map(function(part) {
            let sourceKey = normalizePLMLink(getPLMItemLevelLink(getPartItemLink(part)));
            return {
                part               : part,
                material           : getMaterialValue(part),
                accountingUnit     : getMBOMAccountingUnit(part),
                accountingQuantity : getMBOMAccountingQuantity(part),
                productGroup       : getMBOMAccountingFieldValue(part, rawMaterialProductGroupFieldId),
                hasBom             : isMBOMHasBOM(getMBOMAccountingFieldValue(part, 'HAS_BOM')),
                detailsError       : false,
                assignedRawMaterialLinks : assignments.get(sourceKey) || new Set()
            };
        }));
    }

    function getRawMaterialSourceParts(parts) {
        let seen = new Set();
        return parts.filter(function(part) {
            if(!part || !isMBOMTechnologyItem(getMBOMItemForPart(part))) return false;
            let key = normalizePLMLink(getPartItemLink(part));
            if(!isBlank(key)) {
                if(seen.has(key)) return false;
                seen.add(key);
            }
            return true;
        });
    }

    async function resolveMBOMMaterials(mbomParts) {
        await refreshRawMaterialPartsListIfNeeded();
        await ensureRawMaterialTreeExpanded();
        let inputParts = Array.isArray(mbomParts) ? mbomParts : [];
        let allParts = inputParts
            .concat(Array.isArray(mbomPartsList) ? mbomPartsList : [])
            .concat(getRawMaterialDOMSourceParts());
        let mbomSourceParts = getRawMaterialSourceParts(allParts);

        console.log('MBOM custom: raw material sources restricted to MBOM roots', {
            loadedItems : mbomParts.length,
            mbomRoots   : mbomSourceParts.length
        });

        let mbomMaterials = mbomSourceParts.map(function(part) {
            return {
                part               : part,
                material           : getMaterialValue(part),
                accountingUnit     : getMBOMAccountingUnit(part),
                accountingQuantity : getMBOMAccountingQuantity(part),
                productGroup       : getMBOMAccountingFieldValue(part, rawMaterialProductGroupFieldId)
            };
        });

        // Read the marker from item details even when MATERIAL and quantity are already in the BOM view.
        let missingFallbackParts = mbomMaterials;

        return fetchMBOMPartMaterialsFromDetails(missingFallbackParts.map(function(entry) { return entry.part; }))
            .then(function(results) {
                let fallbackMap = new Map();
                results.forEach(function(result) {
                    let link = getPartItemLink(result.part);
                    if(!isBlank(link)) fallbackMap.set(link, result);
                });

            mbomMaterials.forEach(function(entry) {
                let fallback = fallbackMap.get(getPartItemLink(entry.part));
                if(!fallback) { entry.detailsError = true; return; }
                entry.hasBom = fallback.hasBom === true;
                entry.detailsError = fallback.detailsError === true;

                if(isBlank(entry.material) && !isBlank(fallback.material)) entry.material = fallback.material;
                if(isBlank(entry.accountingUnit) && !isBlank(fallback.accountingUnit)) {
                    entry.accountingUnit = fallback.accountingUnit;
                }
                if((Number.isNaN(entry.accountingQuantity) || entry.accountingQuantity <= 0) &&
                    !Number.isNaN(fallback.accountingQuantity) && fallback.accountingQuantity > 0) {
                    entry.accountingQuantity = fallback.accountingQuantity;
                }
                if(isBlank(entry.productGroup) && !isBlank(fallback.productGroup)) {
                    entry.productGroup = fallback.productGroup;
                }
                });

                return filterRawMaterialEntriesWithMaterial(mbomMaterials);
            })
            .catch(function() { return filterRawMaterialEntriesWithMaterial(mbomMaterials); });
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
        $('#raw-material-results').removeClass('with-warning').hide().empty();
        $('#dialog-raw-materials').show();
    }

    function setRawMaterialsDialogPendingState() {
        $('#raw-step-counter1').html('Przygotowywanie…');
        $('#raw-step-counter2').html('Oczekiwanie…');
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

    function requestRawMaterialCreationConfirmation(materials) {
        if(!Array.isArray(materials) || materials.length === 0) return Promise.resolve(true);

        return new Promise(function(resolve) {
            let container = $('#raw-material-results').empty().removeClass('with-warning').show();
            $('<p></p>')
                .text('Poniższe surowce nie istnieją w PLM. Po utworzeniu wymagają zwolnienia i nie zostaną jeszcze dodane do mBOM:')
                .appendTo(container);

            let list = $('<ul></ul>').addClass('raw-material-creation-list').appendTo(container);
            materials.forEach(function(entry) {
                let group = isBlank(entry.productGroup) ? 'brak wartości GRUPA_PRODUKTOWA_SUROWCOW' : entry.productGroup;
                $('<li></li>').text(entry.material + ' — grupa produktowa: ' + group).appendTo(list);
            });

            let actions = $('<div></div>').addClass('raw-material-confirm-actions').appendTo(container);
            let skip = $('<button type="button"></button>')
                .addClass('button')
                .text('Pomiń tworzenie')
                .appendTo(actions);
            let create = $('<button type="button"></button>')
                .addClass('button default')
                .text('Utwórz surowce (' + materials.length + ')')
                .appendTo(actions);

            $('#raw-step-counter1').text('Oczekiwanie na potwierdzenie');

            function finish(confirmed) {
                skip.off('click');
                create.off('click');
                container.empty().hide();
                resolve(confirmed);
            }

            skip.one('click', function() { finish(false); });
            create.one('click', function() { finish(true); });
        });
    }

    function updateRawMaterialsApplyDialog(current, total) {
        let done = Number(current) || 0;
        let count = Number(total) || 0;
        let progress = count > 0 ? (done * 100 / count) : 100;

        $('#raw-step-bar2').css('width', progress + '%');
        $('#raw-step-counter2').html(done + ' of ' + count);
    }

    function setRawMaterialsDialogResult(summary) {
        let result = summary || {};
        let issues = getRawMaterialReportRows(result.entries);
        let lines = [];
        if(issues.length > 0) lines.push('Nie zastosowano surowca w ' + issues.length + ' mBOM:');
        if(result.error) {
            lines.push('Przetwarzanie zatrzymano przed zastosowaniem wszystkich surowców.');
            (result.materialErrors || []).forEach(function(failure) {
                lines.push(failure.material + ': ' + failure.message);
            });
        }
        if(lines.length === 0) lines.push('Brak problemów.');
        $('#raw-material-results')
            .toggleClass('with-warning', issues.length > 0 || result.error === true)
            .text(lines.join('\n'))
            .show();
    }

    function getRawMaterialReportRows(entries) {
        return (entries || []).filter(function(entry) {
            return entry.hasBom !== true &&
                entry.rawMaterialOutcome !== 'added' &&
                entry.rawMaterialOutcome !== 'updated' &&
                entry.rawMaterialOutcome !== 'unchanged';
        }).map(function(entry) {
            let link = getPartItemLink(entry.part) || '';
            let match = String(link).match(/workspaces\/(\d+)\/items\/(\d+)/);
            let href = match && typeof tenant !== 'undefined'
                ? 'https://' + tenant + '.autodeskplm360.net/plm/workspaces/' + match[1]
                    + '/items/itemDetails?view=full&tab=details&mode=view&itemId=urn%60adsk,plm%60tenant,workspace,item%60'
                    + encodeURIComponent(tenant + ',' + match[1] + ',' + match[2])
                : '';
            let warnings = (entry.rawMaterialWarnings || []).slice();
            if(entry.uomMismatch) warnings.push('Niezgodność jednostek: mBOM „' + (entry.uomMismatch.mbomUnit || 'brak')
                + '”, surowiec „' + (entry.uomMismatch.rawMaterialUOM || 'brak') + '”. Ilość zastosowano bez przeliczenia.');
            return {
                label: getPartNumber(entry.part) || link || 'Unsaved MBOM', href: href,
                material: entry.material || '(empty)', outcome: entry.rawMaterialOutcome || 'not-added',
                message: entry.rawMaterialMessage || 'Not processed.', warnings: warnings
            };
        });
    }

    function renderRawMaterialReport(entries) {
        let rows = getRawMaterialReportRows(entries);
        if(rows.length === 0) return;
        let container = $('#raw-material-results');
        $('<p></p>').text('Otwórz poniższy mBOM, aby sprawdzić problem.').appendTo(container);
        let list = $('<ul></ul>').addClass('raw-material-report').appendTo(container);
        rows.forEach(function(row) {
            let item = $('<li></li>').appendTo(list);
            if(row.href) $('<a></a>').attr({ href: row.href, target: '_blank', rel: 'noopener noreferrer' }).text(row.label).appendTo(item);
            else $('<span></span>').text(row.label).appendTo(item);
            $('<div></div>').text((row.outcome === 'not-added' ? 'Nie dodano: ' : row.outcome === 'updated' ? 'Zaktualizowano: ' : 'Dodano: ') + row.material + ' — ' + row.message).appendTo(item);
            row.warnings.forEach(function(warning) { $('<div></div>').addClass('raw-material-warning').text(warning).appendTo(item); });
        });
    }

    function completeRawMaterialsDialog(total, summary) {
        let count = Number(total) || 0;
        $('#raw-step-bar2').css('width', '100%');
        $('#raw-step-counter2').html(count + ' of ' + count);
        $('#raw-step2').removeClass('in-work');
        if(summary) {
            setRawMaterialsDialogResult(summary);
            renderRawMaterialReport(summary.entries);
        }
        $('#confirm-raw-materials').removeClass('disabled').addClass('default');
    }

    function prepareRawMaterialTarget(entry, createFallbackProcess) {
        return ensureMBOMBranchReadyForRawMaterial(entry.part).then(function() {
            let elemHeader = getRawMaterialTargetHeader(entry.part);
            if(elemHeader.length > 0 || createFallbackProcess !== true) return elemHeader;
            return ensureRawMaterialFallbackProcess(entry.part);
        }).then(function(elemHeader) {
            if(!elemHeader || elemHeader.length === 0) return null;

            let targetKey = getRawMaterialTargetKey(elemHeader);
            return fetchExistingBOMChildren(elemHeader).then(function(existingState) {
                return {
                    elemHeader    : elemHeader,
                    targetKey     : targetKey,
                    existingState : existingState
                };
            });
        }).catch(function(error) {
            entry.rawMaterialPreparationError = getRawMaterialErrorMessage(error);
            console.warn('MBOM custom: failed to prepare raw material target', {
                mbomLink : getPartItemLink(entry.part),
                error    : error
            });
            return null;
        });
    }

    function normalizeRawMaterialApplyMode(mode) {
        if(mode === rawMaterialApplyModes.addMissing || mode === rawMaterialApplyModes.updateQuantity) return mode;
        return rawMaterialApplyModes.overwrite;
    }

    function shouldPreserveAssignedRawMaterial(entry, link, mode) {
        if(mode !== rawMaterialApplyModes.addMissing || !entry || !(entry.assignedRawMaterialLinks instanceof Set)) return false;
        let normalizedLink = normalizePLMVersionLink(link);
        return !isBlank(normalizedLink) && entry.assignedRawMaterialLinks.has(normalizedLink);
    }

    function hasExistingRawMaterialVersion(existingState, link) {
        if(!existingState || isBlank(link)) return false;
        let versionLink = normalizePLMVersionLink(link);
        if(existingState.versionLinks instanceof Set && existingState.versionLinks.has(versionLink)) return true;

        // Item-level links do not expose a revision and can only be compared by item identity.
        if(versionLink.indexOf('/versions/') < 0) {
            return existingState.links instanceof Set && existingState.links.has(normalizePLMLink(link));
        }
        return false;
    }

    function addRawMaterialsToMBOM(mbomMaterials, applyMode) {
        let mode = normalizeRawMaterialApplyMode(applyMode);
        let addMissing = mode !== rawMaterialApplyModes.updateQuantity;
        let updateQuantity = mode !== rawMaterialApplyModes.addMissing;

        if(!Array.isArray(mbomMaterials) || mbomMaterials.length === 0) {
            console.info('MBOM custom: no MBOM parts with MATERIAL values available to add raw materials.');
            completeRawMaterialsSearchDialog(0);
            completeRawMaterialsDialog(0, {
                found   : 0,
                added   : 0,
                updated : 0,
                skipped : 0
            });
            return Promise.resolve();
        }

        console.log('MBOM custom: Found', mbomMaterials.length, 'MBOM part(s) with MATERIAL values.', {
            mode           : mode,
            addMissing     : addMissing,
            updateQuantity : updateQuantity
        });

        let button = $('#add-raw-materials');
        if(button.length) {
            button.addClass('disabled');
            button.html('Wyszukiwanie…');
        }

        mbomMaterials.forEach(function(entry) {
            entry.rawMaterialOutcome = 'not-added';
            entry.rawMaterialMessage = getRawMaterialSkipReason(entry) || (isBlank(entry.material) ? 'Pole MATERIAL jest puste.' : 'Nie znaleziono pasującego surowca.');
            entry.rawMaterialWarnings = [];
        });
        let uniqueMaterials = Array.from(new Set(mbomMaterials.filter(function(entry) { return !getRawMaterialSkipReason(entry); }).map(function(entry) { return entry.material; }).filter(function(material) { return !isBlank(material); })));
        let productGroupsByMaterial = {};
        mbomMaterials.forEach(function(entry) {
            if(isBlank(entry.material) || isBlank(entry.productGroup) || !isBlank(productGroupsByMaterial[entry.material])) return;
            productGroupsByMaterial[entry.material] = entry.productGroup;
        });
        let searchResultsByMaterial = {};
        let searchDone = 0;
        let applyDone = 0;
        let totalAdded = 0;
        let totalUpdated = 0;
        let targetPreparationPromises = new Map();

        setRawMaterialsDialogTotals(uniqueMaterials.length, mbomMaterials.length);

        // Target expansion and duplicate checks do not depend on the search
        // result, so let them run while material searches are in progress.
        mbomMaterials.forEach(function(entry) {
            if(getRawMaterialSkipReason(entry)) return;
            targetPreparationPromises.set(
                entry,
                entry.targetPreparationPromise || prepareRawMaterialTarget(entry)
            );
        });

        let searchRequests = uniqueMaterials.map(function(material) {
            return resolveRawMaterialForBatch(material, false, productGroupsByMaterial[material]).then(function(result) {
                searchResultsByMaterial[material] = result;
                searchDone++;
                updateRawMaterialsSearchDialog(searchDone, uniqueMaterials.length);
                return result;
            });
        });

        return Promise.all(searchRequests).then(function() {
            let missingMaterials = uniqueMaterials.filter(function(material) {
                let result = searchResultsByMaterial[material];
                return result && !result.error && result.unreleasedOnly !== true &&
                    Array.isArray(result.items) && result.items.length === 0;
            }).map(function(material) {
                return { material : material, productGroup : productGroupsByMaterial[material] || '' };
            });

            if(!addMissing || missingMaterials.length === 0) return true;

            return requestRawMaterialCreationConfirmation(missingMaterials).then(function(confirmed) {
                if(!confirmed) {
                    missingMaterials.forEach(function(entry) {
                        let result = searchResultsByMaterial[entry.material];
                        result.creationDeclined = true;
                        result.message = 'Utworzenie surowca nie zostało potwierdzone.';
                    });
                    return false;
                }

                $('#raw-step-counter1').text('Tworzenie: 0 z ' + missingMaterials.length);
                let created = 0;
                return Promise.all(missingMaterials.map(function(entry) {
                    let result = searchResultsByMaterial[entry.material];
                    return ensureRawMaterialSearchResult(result, entry.productGroup).then(function(createdResult) {
                        searchResultsByMaterial[entry.material] = createdResult;
                    }).catch(function(error) {
                        searchResultsByMaterial[entry.material] = {
                            material : entry.material,
                            items    : [],
                            error    : true,
                            message  : getRawMaterialErrorMessage(error)
                        };
                    }).then(function() {
                        created++;
                        $('#raw-step-counter1').text('Tworzenie: ' + created + ' z ' + missingMaterials.length);
                    });
                })).then(function() { return true; });
            });
        }).then(function() {
            completeRawMaterialsSearchDialog(uniqueMaterials.length);
            let insertedByTarget = {};
            let targetWorkPromises = {};
            let nextEntryIndex = 0;

            function queueTargetWork(targetKey, work) {
                let previous = targetWorkPromises[targetKey] || Promise.resolve();
                let current = previous.then(work, work);
                targetWorkPromises[targetKey] = current.catch(function() {});
                return current;
            }

            function applyNextEntry() {
                if(nextEntryIndex >= mbomMaterials.length) return Promise.resolve();
                let entry = mbomMaterials[nextEntryIndex++];

                return Promise.resolve().then(function() {
                    let material = entry.material;
                    if(getRawMaterialSkipReason(entry)) {
                        applyDone++;
                        updateRawMaterialsApplyDialog(applyDone, mbomMaterials.length);
                        return null;
                    }

                    let result = searchResultsByMaterial[material];
                    if(result && result.error) entry.rawMaterialMessage = result.message;
                    if(result && result.creationDeclined) entry.rawMaterialMessage = result.message;
                    if(result && result.unreleasedOnly) {
                        entry.rawMaterialMessage = result.created
                            ? 'Surowiec został utworzony, ale nie jest jeszcze zwolniony. Nie dodano go do mBOM.'
                            : 'Znaleziono pasujący surowiec, ale nie ma on zwolnionej wersji. Nie dodano go do mBOM.';
                        entry.rawMaterialWarnings.push('Do mBOM można dodać wyłącznie zwolnioną wersję surowca.');
                    }
                    if(!result || !Array.isArray(result.items) || result.items.length === 0) {
                        console.warn('MBOM custom: no matching WS57 TITLE found for MATERIAL', {
                            material : material
                        });
                        applyDone++;
                        updateRawMaterialsApplyDialog(applyDone, mbomMaterials.length);
                        return null;
                    }

                    let item = chooseRawMaterialItem(material, result.items);
                    if(!item) {
                        entry.rawMaterialMessage = 'Nie udało się wybrać dokładnego dopasowania pola TITLE.';
                        console.warn('MBOM custom: TITLE match selection failed for MATERIAL', {
                            material : material
                        });
                        applyDone++;
                        updateRawMaterialsApplyDialog(applyDone, mbomMaterials.length);
                        return null;
                    }

                    let link = getSearchItemLink(item);
                    if(isBlank(link)) {
                        entry.rawMaterialMessage = 'Surowiec nie ma prawidłowego odnośnika do elementu.';
                        console.warn('MBOM custom: raw material match has no usable link', {
                            material : material
                        });
                        applyDone++;
                        updateRawMaterialsApplyDialog(applyDone, mbomMaterials.length);
                        return null;
                    }

                    if(shouldPreserveAssignedRawMaterial(entry, link, mode)) {
                        entry.rawMaterialOutcome = 'unchanged';
                        entry.rawMaterialMessage = 'Surowiec jest już przypisany do tego mBOM; pozostawiono go bez zmian.';
                        applyDone++;
                        updateRawMaterialsApplyDialog(applyDone, mbomMaterials.length);
                        return null;
                    }

                    return getRawMaterialInsertQuantity(entry, item).then(function(quantity) {
                        if(Number.isNaN(quantity) || quantity <= 0) {
                        entry.rawMaterialMessage = 'Brak wartości pola ILOSC_ROZLICZENIOWA lub wartość jest nieprawidłowa.';
                            applyDone++;
                            updateRawMaterialsApplyDialog(applyDone, mbomMaterials.length);
                            return null;
                        }

                        return targetPreparationPromises.get(entry).then(function(targetContext) {
                            if(targetContext) return targetContext;
                            return prepareRawMaterialTarget(entry, addMissing);
                        }).then(function(targetContext) {
                            if(!targetContext) {
                                entry.rawMaterialMessage = entry.rawMaterialPreparationError || 'Nie udało się przygotować operacji dla tego mBOM.';
                                console.warn('MBOM custom: cannot find MBOM insertion target', {
                                    material : material,
                                    mbomLink  : getPartItemLink(entry.part)
                                });
                                applyDone++;
                                updateRawMaterialsApplyDialog(applyDone, mbomMaterials.length);
                                return null;
                            }

                            let elemHeader = targetContext.elemHeader;
                            let targetKey = targetContext.targetKey;
                            console.log('MBOM custom: inserting new raw material into MBOM', {
                                material : material,
                                targetKey: targetKey,
                                link     : link,
                                quantity : quantity
                            });

                            return queueTargetWork(targetKey, function() {
                                let existingState = insertedByTarget[targetKey] || targetContext.existingState;
                                insertedByTarget[targetKey] = existingState;
                                let normalizedLink = normalizePLMLink(link);

                                console.log('MBOM custom: resolved raw material target', {
                                    material : material,
                                    targetKey: targetKey,
                                    link     : link,
                                    quantity : quantity
                                });

                                if(hasExistingRawMaterialVersion(existingState, link)) {
                                    console.log('MBOM custom: raw material precheck found existing target assignment', {
                                        material : material,
                                        link     : link,
                                        targetKey: targetKey
                                    });

                                    if(!updateQuantity) {
                                        entry.rawMaterialOutcome = 'unchanged';
                                        entry.rawMaterialMessage = 'Surowiec już istnieje; ilość pozostawiono bez zmian.';
                                        applyDone++;
                                        updateRawMaterialsApplyDialog(applyDone, mbomMaterials.length);
                                        return null;
                                    }

                                    let elemExisting = getDirectChildItemByLink(elemHeader, link);
                                    if(elemExisting.length === 0) {
                                        let existingPart = existingState.children.get(normalizedLink);
                                        elemExisting = ensureExistingRawMaterialRow(elemHeader, existingPart);
                                    }

                                    if(elemExisting.length > 0 && setRawMaterialQuantity(elemHeader, link, quantity)) {
                                        totalUpdated++;
                                        entry.rawMaterialOutcome = 'updated';
                                        entry.rawMaterialMessage = 'Surowiec już istnieje; ilość została zaktualizowana.';
                                        console.log('MBOM custom: raw material already exists, quantity set to resolved value', {
                                            material : material,
                                            link     : link,
                                            targetKey: targetKey,
                                            quantity : quantity
                                        });
                                    } else {
                                        entry.rawMaterialMessage = 'Surowiec już istnieje, ale nie udało się zaktualizować jego ilości.';
                                        console.warn('MBOM custom: raw material exists but DOM row could not be updated', {
                                            material : material,
                                            link     : link,
                                            targetKey: targetKey
                                        });
                                    }
                                    applyDone++;
                                    updateRawMaterialsApplyDialog(applyDone, mbomMaterials.length);
                                    return null;
                                }

                                if(!addMissing) {
                                    entry.rawMaterialOutcome = 'unchanged';
                                    entry.rawMaterialMessage = 'Brakującego surowca nie dodano w trybie aktualizacji ilości.';
                                    applyDone++;
                                    updateRawMaterialsApplyDialog(applyDone, mbomMaterials.length);
                                    return null;
                                }

                                console.log('MBOM custom: inserting new raw material into MBOM', {
                                    material : material,
                                    link     : link,
                                    targetKey: targetKey,
                                    quantity : quantity
                                });

                                return getRawMaterialItemDetails(link).then(function(detailsData) {
                                    return insertAdditionalItem(elemHeader, link, {
                                        knownLeaf  : true,
                                        detailsData: detailsData
                                    });
                                }).then(function(elemInserted) {
                                    if(!elemInserted || elemInserted.length === 0) {
                                        throw new Error('Nie udało się wstawić surowca do struktury mBOM.');
                                    }

                                    existingState.links.add(normalizedLink);
                                    if(existingState.versionLinks instanceof Set) {
                                        existingState.versionLinks.add(normalizePLMVersionLink(link));
                                    }
                                    existingState.children.set(normalizedLink, { link : link, quantity : quantity });
                                    totalAdded++;
                                    entry.rawMaterialOutcome = 'added';
                                    entry.rawMaterialMessage = 'Surowiec został dodany.';

                                    return waitForDirectChildItem(elemHeader, link).then(function(elemInserted) {
                                        if(elemInserted.length === 0) {
                                            entry.rawMaterialWarnings.push('Nie znaleziono wstawionego wiersza; sprawdź ilość przed zapisaniem.');
                                            console.warn('MBOM custom: inserted raw material row was not found in DOM after insert', {
                                                material : material,
                                                link     : link,
                                                targetKey: targetKey
                                            });
                                            return null;
                                        }

                                        if(!setRawMaterialQuantity(elemHeader, link, quantity)) {
                                            entry.rawMaterialWarnings.push('Nie udało się ustawić ilości; sprawdź ją przed zapisaniem.');
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
                                    updateRawMaterialsApplyDialog(applyDone, mbomMaterials.length);
                                    console.log('MBOM custom: raw material insert completed', {
                                        material : material,
                                        link     : link,
                                        targetKey: targetKey
                                    });
                                });
                            });
                        });
                    });
                }).catch(function(error) {
                    entry.rawMaterialMessage = getRawMaterialErrorMessage(error);
                    console.warn('MBOM custom: failed to apply raw material', { entry: entry, error: error });
                    applyDone++;
                    updateRawMaterialsApplyDialog(applyDone, mbomMaterials.length);
                }).then(applyNextEntry);
            }

            let applyWorkers = [];
            let applyWorkerCount = Math.min(4, mbomMaterials.length);
            for(let workerIndex = 0; workerIndex < applyWorkerCount; workerIndex++) {
                applyWorkers.push(applyNextEntry());
            }

            return Promise.all(applyWorkers).then(function() {
                let uomCheckedEntries = mbomMaterials.filter(function(entry) {
                    return entry && entry.uomChecked === true;
                });
                let uomMismatches = mbomMaterials
                    .filter(function(entry) { return entry && entry.uomMismatch; })
                    .map(function(entry) { return entry.uomMismatch; });

                console.log('MBOM custom: Add Raw Materials finished', {
                    added        : totalAdded,
                    updated      : totalUpdated,
                    total        : mbomMaterials.length,
                    uomMismatches: uomMismatches.length
                });

                console.log('MBOM custom: Add Raw Materials UOM check finished', {
                    checked    : uomCheckedEntries.length,
                    matched    : uomCheckedEntries.length - uomMismatches.length,
                    mismatches : uomMismatches
                });

                if(totalAdded === 0 && totalUpdated === 0) {
                    console.info('MBOM custom: no raw materials were added or updated. Check MATERIAL values and matching TITLE values in WS 57.');
                }

                completeRawMaterialsDialog(mbomMaterials.length, {
                    found         : mbomMaterials.length,
                    added         : totalAdded,
                    updated       : totalUpdated,
                    skipped       : Math.max(0, mbomMaterials.length - totalAdded - totalUpdated),
                    uomMismatches : uomMismatches.length,
                    entries: mbomMaterials,
                    materialErrors: Object.values(searchResultsByMaterial).filter(function(result) { return result.error; })
                });

                if(button.length) {
                    button.removeClass('disabled');
                    button.html('Dodaj Surowce');
                }
            });
        }).catch(function(error) {
            console.warn('MBOM custom: raw material search failed', error);
            completeRawMaterialsDialog(applyDone, {
                found   : mbomMaterials.length,
                added   : totalAdded,
                updated : totalUpdated,
                skipped : Math.max(0, mbomMaterials.length - totalAdded - totalUpdated),
                error   : true,
                entries : mbomMaterials
            });
            if(button.length) {
                button.removeClass('disabled');
                button.html('Dodaj Surowce');
            }
        });
    }

    function addRawMaterialsFromMBOM() {
        if($('#add-raw-materials').hasClass('disabled')) return;
        $('#overlay, #dialog-confirm-raw-materials').show();
        $('#cancel-add-raw-materials').off('click').on('click', function() {
            $('#overlay, #dialog-confirm-raw-materials').hide();
        });
        let modeButtons = [{
            selector : '#start-add-missing-raw-materials',
            mode     : rawMaterialApplyModes.addMissing
        }, {
            selector : '#start-update-raw-material-quantities',
            mode     : rawMaterialApplyModes.updateQuantity
        }, {
            selector : '#start-overwrite-raw-materials',
            mode     : rawMaterialApplyModes.overwrite
        }];

        modeButtons.forEach(function(option) {
            $(option.selector).off('click').on('click', function() {
                $('#dialog-confirm-raw-materials').hide();
                startRawMaterialsFromMBOM(option.mode);
            });
        });
        $('#start-add-missing-raw-materials').trigger('focus');
    }

    function startRawMaterialsFromMBOM(applyMode) {
        let mode = normalizeRawMaterialApplyMode(applyMode);
        console.log('MBOM custom: Add Raw Materials button clicked', { mode: mode });
        initRawMaterialsDialog(0, 0);
        setRawMaterialsDialogPendingState();

        return loadRawMaterialsBOMParts().then(function(parts) {
            let mbomMaterials = resolveRawMaterialsBOMViewParts(parts);
            return addRawMaterialsToMBOM(mbomMaterials, mode);
        }).catch(function(error) {
            console.warn('MBOM custom: failed to load the Raw Materials BOM view', error);
            completeRawMaterialsDialog(0, {
                error          : true,
                materialErrors : [{ material : 'Wyszukiwanie', message : getRawMaterialErrorMessage(error) }]
            });
        });
    }

    function getMissingLeafLinkedMBOMs() {
        let result = [];
        $('#ebom-tree .item').each(function() {
            let elemItem = $(this);
            if(elemItem.hasClass('root') || getRenderedDirectChildren(elemItem).length > 0) return;
            if(!elemItem.hasClass('linked-mbom-missing')) return;

            let linkedMBOM = getLinkedMBOMLinkFromEBOMElement(elemItem);
            let elemAction = elemItem.children('.item-head').children('.item-actions')
                .children('.item-action-add-linked-mbom').first();
            if(isBlank(linkedMBOM) || elemAction.length === 0) return;
            result.push({ elemItem: elemItem, elemAction: elemAction, link: linkedMBOM });
        });
        return result;
    }

    async function addLeafMBOMsAndRawMaterials() {
        let elemButton = $('#add-leaf-mboms-and-materials');
        if(elemButton.hasClass('disabled')) return;
        if(!validateMBOMComponentTarget()) return;

        let candidates = getMissingLeafLinkedMBOMs();
        if(candidates.length === 0) {
            showErrorMessage('Dodawanie mBOM-ów liści', 'Nie znaleziono brakującego połączonego mBOM dla elementu eBOM bez elementów podrzędnych.');
            return;
        }

        elemButton.addClass('disabled').text('Dodawanie mBOM-ów…');
        $('#overlay').show();
        try {
            let materialParts = [];
            candidates.forEach(function(candidate) {
                materialParts.push({ link: candidate.link });
                candidate.elemAction.trigger('click');
            });
            refreshNewLinkedMBOMControls();
            setTotalQuantities();
            setStatusBar();

            elemButton.text('Dodawanie surowców…');
            initRawMaterialsDialog(0, 0);
            setRawMaterialsDialogPendingState();
            let mbomMaterials = await resolveMBOMMaterials(materialParts);
            await addRawMaterialsToMBOM(mbomMaterials);
        } catch(error) {
            console.warn('MBOM custom: adding leaf MBOMs and raw materials failed', error);
            showErrorMessage('Dodawanie mBOM-ów liści', String(error && error.message ? error.message : error));
        } finally {
            elemButton.removeClass('disabled').text('Dodaj mBOM-y liści i surowce');
            $('#overlay').hide();
        }
    }

    function insertAddLeafMBOMsAndMaterialsButton() {
        if($('#add-leaf-mboms-and-materials').length > 0 || $('#add-all').length === 0) return;
        $('<div></div>')
            .attr('id', 'add-leaf-mboms-and-materials')
            .addClass('button')
            .attr('title', 'Dodaj brakujące połączone mBOM-y dla elementów liści eBOM, a następnie dodaj ich surowce w operacji Cięcie')
            .text('Dodaj mBOM-y liści i surowce')
            .on('click', addLeafMBOMsAndRawMaterials)
            .insertAfter('#add-all');
    }

    function escapeERPStatusHtml(value) {
        return $('<div></div>').text(value || '').html();
    }

    const erpTechnologyProxyBaseUrl = '/plm/custom-erp/';
    const erpSyncBOMViewName = 'ERP Sync';
    const erpTechnologyPropertyMappings = [
        ['Grupa Produktowa', ['GRUPA_PRODUKTOWA']],
        ['Typ czesci', ['TYP_CZESCI']]
    ];
    const erpAssemblyIndexProductGroupId = assemblyIndexPLMDefaults.productGroup;
    const erpAssemblyIndexProductPropertyMappings = [
        ['Opis', ['OPIS']],
        ['Nazwa', ['NAZWA']],
        ['Tytuł', ['TITLE']],
        ['Tutuł', ['TITLE']],
        ['Rewizja', ['REVISION']],
        ['Materiał', ['MATERIAL']],
        ['Specyfikacja', ['SPECYFIKACJA'], assemblyIndexPLMDefaults.specification],
        ['Status', ['STATUS']],
        ['Grupa produktowa', ['GRUPA_PRODUKTOWA'], assemblyIndexPLMDefaults.productGroup],
        ['Typ części', ['TYP_CZESCI'], assemblyIndexPLMDefaults.partType],
        ['Rodzaj', ['RODZAJ'], assemblyIndexPLMDefaults.kind],
        ['Wariant', ['WARIANT'], assemblyIndexPLMDefaults.variant],
        ['Nazwa urządzenia', ['NAZWA_URZDZENIA'], '', true],
        ['Moc/Wielkość', ['MOC'], '', true],
        ['Lifecycle', ['LIFECYCLE']]
    ];
    const erpSubMBOMProductPropertyMappings = [
        ['Materiał', ['MATERIAL']],
        ['Masa', ['ITEM_WEIGHT']],
        ['Opis', ['OPIS']],
        ['Nazwa', ['NAZWA']],
        ['Tytuł', ['TITLE']],
        ['Tutuł', ['TITLE']],
        ['Grupa produktowa', ['GRUPA_PRODUKTOWA']],
        ['Nazwa urządzenia', ['NAZWA_URZDZENIA']],
        ['Typ części', ['TYP_CZESCI']],
        ['Rodzaj', ['RODZAJ']],
        ['Wariant', ['WARIANT']],
        ['Specyfikacja', ['SPECYFIKACJA']],
        ['Producent', ['PRODUCENT']],
        ['Szerokość', ['WIDTH']],
        ['Długość', ['LENGTH']],
        ['Wysokość/grubość', ['HEIGHT']],
        ['Średnica', ['SREDNICA']],
        ['Kolor', ['KOLOR']],
        ['Powłoka', ['POWLOKA']],
        ['Moc', ['MOC']],
        ['Moc/Wielkość', ['MOC']],
        ['Napięcie', ['NAPICIE']],
        ['Prąd', ['PRD']],
        ['Wydajność', ['WYDAJNO']],
        ['Temperatura', ['TEMPERATURA']],
        ['Gęstość', ['GSTO']]
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
    let erpSyncBOMViewPromise = null;

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
        if(value === true) return true;
        if(value === false || value === null || typeof value === 'undefined') return false;
        if(typeof value === 'number') return value !== 0;
        if(typeof value === 'string') return ['true', '1', 'yes', 'y'].includes(value.trim().toLowerCase());
        if(typeof value === 'object') return normalizeERPBooleanText(value.value);
        return false;
    }

    function isERPProductSynced(detailsData) {
        let sections = (detailsData && detailsData.sections) ? detailsData.sections : [];
        let fieldIds = config.workspaceMBOM.fieldIDs || {};
        return !isBlank(getSectionFieldValue(sections, customERPFieldIDs.partIndex, '', 'object'));
    }

    function isERPTechnologySynced(detailsData) {
        let sections = (detailsData && detailsData.sections) ? detailsData.sections : [];
        let fieldIds = config.workspaceMBOM.fieldIDs || {};
        return !isBlank(getSectionFieldValue(sections, customERPFieldIDs.versionId, '', 'object'));
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
        if(elemItem.hasClass('assembly-index')) return Promise.resolve(true);

        return resolveInlineSubMBOMContext(elemItem).then(function(context) {
            let expansionLink = context && context.expansionLink ? context.expansionLink : '';
            if(isBlank(expansionLink)) {
                console.log('MBOM custom: ERP technology discovery found no linked sub-MBOM to expand', {
                    link       : getERPTechnologyElementLink(elemItem),
                    descriptor : getERPTechnologyDescriptor(elemItem)
                });
                return false;
            }

            // Every nested branch must be loaded because product readiness is
            // checked for every non-operation component, even when the linked
            // sub-mBOM technology itself has already been synchronized.
            return true;
        }).catch(function(error) {
            console.warn('MBOM custom: ERP technology discovery failed to resolve inline sub-MBOM context, skipping expansion', {
                itemLink   : getERPTechnologyElementLink(elemItem),
                descriptor : getERPTechnologyDescriptor(elemItem),
                error      : error
            });
            return false;
        });
    }

    async function ensureERPTechnologyTreeExpanded() {
        let processed = new Set();
        let expandedCount = 0;
        let rounds = 0;
        let started = Date.now();
        let ownsBulkExpansion = !inlineSubMBOMBulkExpansionActive;
        if(ownsBulkExpansion) inlineSubMBOMBulkExpansionActive = true;

        try {
            while(true) {
                rounds++;
                let expandableItems = getERPTechnologyExpandableItems().filter(function(elemItem) {
                    let link = getERPTechnologyElementLink(elemItem) || '';
                    if(isBlank(link)) return elemItem.attr('data-inline-submbom-loaded') !== 'true' && elemItem.attr('data-inline-submbom-loaded') !== 'empty';
                    return !processed.has(link);
                });

                if(expandableItems.length === 0) return;

                await mapPLMRequestsWithConcurrency(expandableItems, 6, function(elemItem) {
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

                        expandedCount++;
                        return ensureInlineSubMBOMExpanded(elemItem, erpTechnologyDiscoveryDepth).catch(function(error) {
                            console.warn('MBOM custom: failed to expand linked sub-MBOM during ERP technology discovery', {
                                link  : link,
                                error : error
                            });
                            return false;
                        });
                    });
                });
            }
        } finally {
            console.log('MBOM custom: ERP technology tree discovery completed', {
                inspected     : processed.size,
                expanded      : expandedCount,
                rounds        : rounds,
                depthPerMBOM  : erpTechnologyDiscoveryDepth,
                durationMs    : Date.now() - started
            });
            if(ownsBulkExpansion) {
                inlineSubMBOMBulkExpansionActive = false;
                if(typeof updateMBOMNumbers === 'function') updateMBOMNumbers();
                if(typeof setStatusBar === 'function') setStatusBar();
            }
        }
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

    function getERPProductComponentItems() {
        let items = [];
        let seen = new Set();

        $('#mbom-tree').find('.item').each(function() {
            let elemItem = $(this);
            if(elemItem.hasClass('root') || elemItem.hasClass('process')) return;

            let itemLink = getERPTechnologyElementLink(elemItem);
            let key = normalizePLMLink(itemLink);
            if(isBlank(itemLink) || isBlank(key) || seen.has(key)) return;

            seen.add(key);
            items.push(elemItem);
        });

        items.sort(function(a, b) {
            return getElementLevel(a) - getElementLevel(b);
        });

        return items;
    }

    function buildERPComponentProductJob(elemItem) {
        let itemLink = getERPTechnologyElementLink(elemItem);
        let itemPart = getMBOMPartFromElement(elemItem);

        if(isBlank(itemLink)) return Promise.resolve(null);

        return getERPTechnologyItemDetails(itemLink).then(function(itemDetailsData) {
            if(!itemDetailsData) throw new Error('Could not load component details for ERP product check: ' + itemLink);

            let sourceLink = getERPTechnologyEBOMLink(elemItem, itemPart, itemDetailsData) || itemLink;
            let sourceDetailsPromise = normalizePLMLink(sourceLink) === normalizePLMLink(itemLink)
                ? Promise.resolve(itemDetailsData)
                : getERPTechnologyItemDetails(sourceLink);

            return sourceDetailsPromise.then(function(sourceDetailsData) {
                if(!sourceDetailsData) throw new Error('Could not load product source details for ERP product check: ' + sourceLink);
                if(isERPProductSynced(sourceDetailsData)) return null;

                let assemblyIndex = elemItem.hasClass('assembly-index') || isAssemblyIndexNode(itemPart);
                let productPayload = assemblyIndex
                    ? buildERPAssemblyIndexProductPayload(elemItem, itemPart, sourceDetailsData)
                    : buildERPSubMBOMProductPayload(elemItem, itemPart, sourceDetailsData);

                return {
                    jobType           : 'product',
                    elemItem          : elemItem,
                    link              : itemLink,
                    descriptor        : getERPTechnologyDescriptor(elemItem),
                    level             : getElementLevel(elemItem),
                    productRequired   : true,
                    productPayload    : productPayload,
                    productSourceLink : sourceLink,
                    productIndexToCopy: ''
                };
            });
        });
    }

    function collectERPComponentProductJobs() {
        let components = getERPProductComponentItems();

        return mapPLMRequestsWithConcurrency(components, 6, function(elemItem) {
            return buildERPComponentProductJob(elemItem).catch(function(error) {
                console.warn('MBOM custom: component ERP product state could not be checked', {
                    link       : getERPTechnologyElementLink(elemItem),
                    descriptor : getERPTechnologyDescriptor(elemItem),
                    level      : getElementLevel(elemItem),
                    error      : error
                });
                throw error;
            });
        }).then(function(jobs) {
            let seenSources = new Set();
            return jobs.filter(function(job) {
                if(!job) return false;
                let key = normalizePLMLink(job.productSourceLink || job.link);
                if(isBlank(key) || seenSources.has(key)) return false;
                seenSources.add(key);
                return true;
            });
        });
    }

    function isERPTechnologyMainRootItem(elemItem) {
        return isMainMBOMRootItem(elemItem);
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

    function buildERPAddProductName(sections, title, rawIndex) {
        let partName = getERPTechnologySectionValue(sections, ['NAZWA_DEFRO'], '');
        let combinedName = [partName].filter(function(value) {
            return !isBlank(value);
        }).join(' - ');

        return combinedName || title || rawIndex;
    }

    function buildERPAssemblyIndexProductPayload(elemItem, itemPart, detailsData) {
        let sections = (detailsData && detailsData.sections) ? detailsData.sections : [];
        let rawIndex = getERPTechnologySectionValue(sections, ['NUMBER'], '');
        let title = getERPTechnologySectionValue(sections, ['TITLE'], (detailsData && detailsData.title) ? detailsData.title : '');
        let description = getERPTechnologySectionValue(sections, ['OPIS'], title);
        let groupId = getERPTechnologySectionValue(sections, ['GRUPA_PRODUKTOWA'], erpAssemblyIndexProductGroupId);
        let properties = [];

        erpAssemblyIndexProductPropertyMappings.forEach(function(mapping) {
            let value = getERPTechnologySectionValue(sections, mapping[1], '');
            if(isBlank(value) && mapping.length > 2) value = mapping[2];
            if(mapping[0] === 'Grupa produktowa' && isBlank(value)) value = groupId;
            if(mapping[0] === 'Opis' && isBlank(value)) value = description;

            if(mapping[0] === 'Specyfikacja') {
                let normalizedSpecification = normalizeComparisonValue(value);
                if(normalizedSpecification === 'zozenie' || normalizedSpecification === 'zlozenie') {
                    value = assemblyIndexPLMDefaults.specification;
                }
            }

            let includeWhenBlank = mapping[3] === true;
            if(isBlank(value) && !includeWhenBlank) return;

            let property = {};
            property[mapping[0]] = isBlank(value)
                ? ''
                : truncateERPAssemblyIndexPropertyValue(String(value), 40);
            properties.push(property);
        });

        return {
            indeks          : rawIndex,
            nazwa_czesci    : buildERPAddProductName(sections, title, rawIndex),
            id_grupy        : groupId || erpAssemblyIndexProductGroupId,
            jednostka_miary : getERPTechnologyComponentUnitOfMeasure(itemPart, detailsData, elemItem),
            wlasnosci       : properties
        };
    }

    function getERPTechnologyLinkedValue(value) {
        if(isBlank(value)) return '';
        if(typeof value === 'string') return value.trim();
        if(typeof value !== 'object') return '';

        if(!isBlank(value.link)) return String(value.link).trim();
        if(!isBlank(value.__self__)) return String(value.__self__).trim();
        if(typeof value.value !== 'undefined') return getERPTechnologyLinkedValue(value.value);

        return '';
    }

    function getERPTechnologyEBOMLink(elemItem, itemPart, detailsData) {
        let sections = (detailsData && detailsData.sections) ? detailsData.sections : [];
        let fieldIds = (typeof config !== 'undefined' && config.workspaceMBOM && config.workspaceMBOM.fieldIDs)
            ? config.workspaceMBOM.fieldIDs
            : {};
        let candidateIds = [
            fieldIds.ebom,
            'EBOM'
        ].filter(Boolean);

        for(let fieldId of candidateIds) {
            let sectionValue = getSectionFieldValue(sections, fieldId, '', 'link');
            let linkedValue = getERPTechnologyLinkedValue(sectionValue);
            if(!isBlank(linkedValue)) return linkedValue;

            if(itemPart && itemPart.details && typeof itemPart.details[fieldId] !== 'undefined') {
                linkedValue = getERPTechnologyLinkedValue(itemPart.details[fieldId]);
                if(!isBlank(linkedValue)) return linkedValue;
            }
        }

        if(itemPart) {
            let partCandidates = [itemPart.ebom];
            for(let partCandidate of partCandidates) {
                let linkedValue = getERPTechnologyLinkedValue(partCandidate);
                if(!isBlank(linkedValue)) return linkedValue;
            }
        }

        if(elemItem && elemItem.length > 0) {
            return elemItem.attr('data-ebom') ||
                elemItem.attr('data-link-ebom') ||
                '';
        }

        return '';
    }

    function getERPTechnologyStoredPartIndex(itemPart, detailsData) {
        let sections = (detailsData && detailsData.sections) ? detailsData.sections : [];
        let fieldIds = (typeof config !== 'undefined' && config.workspaceMBOM && config.workspaceMBOM.fieldIDs)
            ? config.workspaceMBOM.fieldIDs
            : {};
        let candidateIds = [
            customERPFieldIDs.partIndex,
            'INDEKS_CZESCI',
            'indeks_czesci'
        ];
        let partIndex = getERPTechnologySectionValue(sections, candidateIds, '');

        if(isBlank(partIndex) && itemPart && itemPart.details) {
            partIndex = getERPTechnologyPartDetailsValue(itemPart, candidateIds);
        }

        return isBlank(partIndex) ? '' : String(partIndex).trim();
    }

    function needsERPSubMBOMProduct(elemItem, itemPart, detailsData) {
        if(!elemItem || elemItem.length === 0) return false;

        // INDEKS_CZESCI is copied from the linked EBOM when the mBOM is created
        // or repaired. Only a missing value requires the linked EBOM check.
        return isBlank(getERPTechnologyStoredPartIndex(itemPart, detailsData));
    }

    function buildERPSubMBOMProductPayload(elemItem, itemPart, detailsData) {
        let sections = (detailsData && detailsData.sections) ? detailsData.sections : [];
        let rawIndex = getERPTechnologySectionValue(sections, ['NUMBER'], '');
        let title = getERPTechnologySectionValue(sections, ['TITLE'], (detailsData && detailsData.title) ? detailsData.title : '');
        let description = getERPTechnologySectionValue(sections, ['OPIS'], title);
        let groupId = getERPTechnologySectionValue(sections, ['GRUPA_PRODUKTOWA'], '');
        let properties = [];

        erpSubMBOMProductPropertyMappings.forEach(function(mapping) {
            let value = getERPTechnologySectionValue(sections, mapping[1], '');
            if(mapping[0] === 'Opis' && isBlank(value)) value = description;
            if(isBlank(value)) return;

            let property = {};
            property[mapping[0]] = truncateERPAssemblyIndexPropertyValue(String(value), 40);
            properties.push(property);
        });

        return {
            indeks          : rawIndex,
            nazwa_czesci    : buildERPAddProductName(sections, title, rawIndex),
            id_grupy        : groupId,
            jednostka_miary : getERPTechnologyComponentUnitOfMeasure(itemPart, detailsData, elemItem),
            wlasnosci       : properties
        };
    }

    function resolveERPProductPrerequisite(elemItem, itemPart, detailsData, assemblyIndex, alreadySynced) {
        if(assemblyIndex) {
            return Promise.resolve({
                required   : !alreadySynced,
                payload    : alreadySynced ? null : buildERPAssemblyIndexProductPayload(elemItem, itemPart, detailsData),
                sourceLink : getERPTechnologyElementLink(elemItem),
                indexToCopy: ''
            });
        }

        if(alreadySynced || !needsERPSubMBOMProduct(elemItem, itemPart, detailsData)) {
            return Promise.resolve({ required: false, payload: null, sourceLink: '', indexToCopy: '' });
        }

        let ebomLink = getERPTechnologyEBOMLink(elemItem, itemPart, detailsData);
        if(isBlank(ebomLink)) {
            return Promise.resolve({
                required   : true,
                payload    : buildERPSubMBOMProductPayload(elemItem, itemPart, detailsData),
                sourceLink : getERPTechnologyElementLink(elemItem),
                indexToCopy: ''
            });
        }

        return getERPTechnologyItemDetails(ebomLink).then(function(ebomDetailsData) {
            if(!ebomDetailsData) throw new Error('Could not load linked eBOM details for ERP product check: ' + ebomLink);

            let ebomPartIndex = getERPTechnologyStoredPartIndex(null, ebomDetailsData);
            if(isERPProductSynced(ebomDetailsData)) {
                return {
                    required   : false,
                    payload    : null,
                    sourceLink : ebomLink,
                    indexToCopy: ebomPartIndex
                };
            }

            return {
                required   : true,
                payload    : buildERPSubMBOMProductPayload(null, null, ebomDetailsData),
                sourceLink : ebomLink,
                indexToCopy: ''
            };
        });
    }

    function getERPTechnologyItemDetails(link) {
        if(isBlank(link)) return Promise.resolve(null);
        if(erpTechnologyDetailsCache[link]) return Promise.resolve(erpTechnologyDetailsCache[link]);

        erpTechnologyDetailsCache[link] = runERPTechnologyPLMRequest(function() {
            return $.get('/plm/details', { link : link });
        }).then(function(response) {
            return response && response.data ? response.data : null;
        }).catch(function(error) {
            delete erpTechnologyDetailsCache[link];
            throw error;
        });

        return erpTechnologyDetailsCache[link];
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
        let description = getERPTechnologySectionValue(sections, ['OPIS'], '');
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
        let value = getERPTechnologySectionValue((processDetailsData && processDetailsData.sections) ? processDetailsData.sections : [], [config.workspaceMBOM.fieldIDs.code, 'PROCESS_CODE'], '');

        if(isBlank(value) && processPart && !isBlank(processPart.code)) value = processPart.code;
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
            customERPFieldIDs.partIndex,
            'INDEKS_CZESCI',
            'indeks_czesci'
        ], '');

        if(isBlank(numberValue) && part && part.details) {
            numberValue = getERPTechnologyPartDetailsValue(part, [
                customERPFieldIDs.partIndex,
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
            customERPFieldIDs.versionId,
            'ID_WERSJI',
            'id_wersji'
        ], '');

        if(isBlank(versionValue) && part && part.details) {
            versionValue = getERPTechnologyPartDetailsValue(part, [
                customERPFieldIDs.versionId,
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
            let assemblyIndex = (elemItem && elemItem.hasClass('assembly-index')) || isAssemblyIndexNode(itemPart);
            let productStatePromise = resolveERPProductPrerequisite(
                elemItem,
                itemPart,
                detailsData,
                assemblyIndex,
                alreadySynced
            );
            let payload = {
                indeks          : normalizeERPTechnologyIndex(getERPTechnologySectionValue(sections, ['NUMBER'], '')),
                nazwa_czesci    : getERPTechnologySectionValue(sections, ['NAZWA_DEFRO', 'TITLE'], detailsData.title || ''),
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

            return Promise.all([Promise.all(processPromises), productStatePromise]).then(function(results) {
                sortERPTechnologyOperations(payload);
                sortERPTechnologyStructure(payload);

                let productState = results[1] || {};

                return {
                    elemItem       : elemItem,
                    link           : itemLink,
                    descriptor     : getERPTechnologyDescriptor(elemItem),
                    level          : getElementLevel(elemItem),
                    synced         : alreadySynced,
                    isAssemblyIndex: assemblyIndex,
                    productRequired: productState.required === true,
                    productPayload : productState.payload || null,
                    productSourceLink: productState.sourceLink || '',
                    productIndexToCopy: productState.indexToCopy || '',
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

    function getERPSyncBOMValue(part, candidateIds, fallbackValue) {
        if(!part || !part.details) return fallbackValue || '';

        for(let candidateId of candidateIds.filter(Boolean)) {
            if(Object.prototype.hasOwnProperty.call(part.details, candidateId) && !isBlank(part.details[candidateId])) {
                return part.details[candidateId];
            }
        }

        let normalizedIds = candidateIds.filter(Boolean).map(function(candidateId) {
            return String(candidateId).toLowerCase().replace(/[^a-z0-9]/g, '');
        });

        for(let fieldId of Object.keys(part.details)) {
            let normalizedFieldId = String(fieldId).toLowerCase().replace(/[^a-z0-9]/g, '');
            if(normalizedIds.includes(normalizedFieldId) && !isBlank(part.details[fieldId])) {
                return part.details[fieldId];
            }
        }

        return fallbackValue || '';
    }

    function isERPSyncBOMOperation(part) {
        let fieldIds = config.workspaceMBOM.fieldIDs || {};
        let isProcess = getERPSyncBOMValue(part, [fieldIds.isProcess, 'IS_PROCESS'], false);
        if(normalizeERPBooleanText(isProcess)) return true;

        let type = String(getERPSyncBOMValue(part, [fieldIds.type, 'TYPE'], '')).trim().toLowerCase();
        if(['operation', 'process', 'operacja', 'proces'].includes(type)) return true;

        return !isBlank(getERPSyncBOMValue(part, [fieldIds.code, 'PROCESS_CODE'], ''));
    }

    function isERPSyncBOMManufacturing(part) {
        let fieldIds = config.workspaceMBOM.fieldIDs || {};
        return String(getERPSyncBOMValue(part, [fieldIds.type, 'TYPE'], '')).trim().toLowerCase() === 'manufacturing';
    }

    const customERPFieldIDs = common.erp.fieldIDs;

    function getERPSyncBOMProductState(part) {
        let fieldIds = config.workspaceMBOM.fieldIDs || {};
        let manufacturing = isERPSyncBOMManufacturing(part);
        let storedPartIndex = getERPSyncBOMValue(part, [customERPFieldIDs.partIndex], '');

        return {
            manufacturing : manufacturing,
            productExists : !isBlank(storedPartIndex),
            updateMode    : manufacturing ? 'index' : 'product'
        };
    }

    function addERPSyncBOMHierarchy(parts) {
        let stack = [];

        parts.forEach(function(part) {
            let level = Number(part.level) || 0;
            part.erpChildren = [];
            while(stack.length > level) stack.pop();
            part.erpParent = level > 0 ? stack[level - 1] || null : null;
            if(part.erpParent) part.erpParent.erpChildren.push(part);
            stack[level] = part;
            stack.length = level + 1;
        });

        return parts;
    }

    function validateERPSyncBOMColumns(parts) {
        let details = parts[0] && parts[0].details ? parts[0].details : {};
        let normalizedColumns = Object.keys(details).map(function(fieldId) {
            return String(fieldId).toLowerCase().replace(/[^a-z0-9]/g, '');
        });
        let fieldIds = config.workspaceMBOM.fieldIDs || {};
        let requiredColumns = [
            { label : 'NUMBER', candidates : [fieldIds.number, 'NUMBER'] },
            { label : 'INDEKS_CZESCI', candidates : [customERPFieldIDs.partIndex] },
            { label : 'ID_WERSJI', candidates : [customERPFieldIDs.versionId] },
            { label : 'ERP_HASH', candidates : [customERPFieldIDs.hash] },
            { label : 'ERP_SYNC_STATUS', candidates : [customERPFieldIDs.syncStatus] },
            { label : 'GRUPA_PRODUKTOWA', candidates : ['GRUPA_PRODUKTOWA'] },
            { label : 'TYPE', candidates : [fieldIds.type, 'TYPE'] },
            { label : 'PROCESS_CODE', candidates : [fieldIds.code, 'PROCESS_CODE'] },
            { label : 'KOD_OPERACJI', candidates : erpTechnologyOperationCodeCandidates }
        ];
        let missing = requiredColumns.filter(function(column) {
            return !column.candidates.filter(Boolean).some(function(candidate) {
                return normalizedColumns.includes(String(candidate).toLowerCase().replace(/[^a-z0-9]/g, ''));
            });
        }).map(function(column) { return column.label; });

        if(missing.length > 0) {
            throw new Error('W widoku BOM „' + erpSyncBOMViewName + '” brakuje wymaganych kolumn: ' + missing.join(', ') + '.');
        }
    }

    function getERPSyncBOMView() {
        if(!erpSyncBOMViewPromise) {
            erpSyncBOMViewPromise = $.get('/plm/bom-view-by-name', {
                wsId     : wsMBOM.wsId,
                name     : erpSyncBOMViewName,
                useCache : true
            }).then(function(response) {
                let view = response && response.data ? response.data : null;
                if(!view || isBlank(view.id)) {
                    throw new Error('Nie znaleziono widoku BOM „' + erpSyncBOMViewName + '”.');
                }
                return view;
            }).catch(function(error) {
                erpSyncBOMViewPromise = null;
                throw error;
            });
        }

        return erpSyncBOMViewPromise;
    }

    function loadERPSyncBOMParts(revisionBias) {
        revisionBias = isBlank(revisionBias) ? 'working' : revisionBias;
        let rootItem = $('#mbom-tree').children('.item').first();
        let mbomLink = !isBlank(links.mbom) ? links.mbom : getMBOMSaveLink(rootItem);
        if(isBlank(mbomLink)) return Promise.reject(new Error('Nie znaleziono zapisanego mBOM do synchronizacji ERP.'));

        return getERPSyncBOMView().then(function(view) {
            return $.get('/plm/bom', {
                link            : mbomLink,
                viewId          : view.id,
                depth           : getCustomMBOMDepth(),
                revisionBias    : revisionBias,
                useCache        : false,
                getBOMPartsList : true
            });
        }).then(function(response) {
            let parts = response && response.data && Array.isArray(response.data.bomPartsList)
                ? response.data.bomPartsList
                : [];
            if(parts.length === 0) throw new Error('Widok BOM „' + erpSyncBOMViewName + '” nie zwrócił żadnych elementów.');
            validateERPSyncBOMColumns(parts);
            return addERPSyncBOMHierarchy(parts);
        });
    }

    function getERPSyncBOMUnitOfMeasure(part) {
        let fieldIds = config.workspaceMBOM.fieldIDs || {};
        return normalizeERPTechnologyUnitOfMeasure(getERPSyncBOMValue(part, [
            fieldIds.unitOfMeasure,
            fieldIds.uom,
            'UNIT_OF_MEASURE',
            'UOM',
            'UNIT',
            'BOM_UOM',
            'ITEM_UOM'
        ], ''));
    }

    function buildERPSyncBOMProductPayload(part, assemblyIndex) {
        let mappings = assemblyIndex ? erpAssemblyIndexProductPropertyMappings : erpSubMBOMProductPropertyMappings;
        let rawIndex = getERPSyncBOMValue(part, ['NUMBER'], part.partNumber || '');
        let title = getERPSyncBOMValue(part, ['TITLE'], part.title || '');
        let description = getERPSyncBOMValue(part, ['OPIS'], title);
        let partName = getERPSyncBOMValue(part, ['NAZWA_DEFRO'], '');
        let groupId = getERPSyncBOMValue(part, ['GRUPA_PRODUKTOWA'], assemblyIndex ? erpAssemblyIndexProductGroupId : '');
        let properties = [];

        mappings.forEach(function(mapping) {
            let value = getERPSyncBOMValue(part, mapping[1], '');
            if(isBlank(value) && mapping.length > 2) value = mapping[2];
            if(mapping[0] === 'Grupa produktowa' && isBlank(value)) value = groupId;
            if(mapping[0] === 'Opis' && isBlank(value)) value = description;
            if(mapping[0] === 'Specyfikacja') {
                let normalizedSpecification = normalizeComparisonValue(value);
                if(normalizedSpecification === 'zozenie' || normalizedSpecification === 'zlozenie') {
                    value = assemblyIndexPLMDefaults.specification;
                }
            }
            if(isBlank(value) && !assemblyIndex) return;
            if(mapping.length > 3 && mapping[3] === true && isBlank(value)) return;

            let property = {};
            property[mapping[0]] = isBlank(value) ? '' : truncateERPAssemblyIndexPropertyValue(String(value), 40);
            properties.push(property);
        });

        return {
            indeks          : rawIndex,
            nazwa_czesci    : [partName].filter(function(value) { return !isBlank(value); }).join(' - ') || title || rawIndex,
            id_grupy        : groupId,
            jednostka_miary : getERPSyncBOMUnitOfMeasure(part),
            wlasnosci       : properties
        };
    }

    function getERPSyncBOMRevision(part) {
        let revision = getERPSyncBOMValue(part, ['REVISION'], part.revision || '');
        return String(revision || '').trim();
    }

    function getERPSyncBOMVersionId(part) {
        let fieldIds = config.workspaceMBOM.fieldIDs || {};
        let value = getERPSyncBOMValue(part, [customERPFieldIDs.versionId], '');
        let number = Number(value);
        return isBlank(value) || Number.isNaN(number) ? '' : Math.trunc(number);
    }

    function getERPSyncBOMProcessNumber(part) {
        let fieldIds = config.workspaceMBOM.fieldIDs || {};
        let value = getERPSyncBOMValue(part, [fieldIds.code, 'PROCESS_CODE'], '');
        let numeric = Number(value);
        if(!Number.isNaN(numeric) && String(value).indexOf('.') > -1) return String(parseInt(numeric, 10));
        return String(value || '').trim();
    }

    function getERPSyncBOMStoredHash(part) {
        return String(getERPSyncBOMValue(part, [customERPFieldIDs.hash], '') || '').trim();
    }

    function getERPSyncBOMStatus(part) {
        let fieldIds = config.workspaceMBOM.fieldIDs || {};
        return String(getERPSyncBOMValue(part, [customERPFieldIDs.syncStatus], '') || '')
            .trim()
            .toUpperCase();
    }

    function buildERPHashInput(job) {
        if(job.jobType === 'product') {
            return {
                type    : 'product',
                product : job.productPayload
            };
        }

        let technology = $.extend(true, {}, job.payload || {});
        delete technology.id_wersji;
        delete technology.zablokowana;

        return {
            type       : 'technology',
            product    : job.productHashPayload,
            technology : technology
        };
    }

    function getERPHashResponseValue(response) {
        let containers = [
            response,
            response && response.data,
            response && response.data && response.data.data,
            response && response.body,
            response && response.data && response.data.body
        ];
        for(let container of containers) {
            if(container && typeof container === 'object' && !isBlank(container.hash)) return String(container.hash);
            if(typeof container === 'string' && container.indexOf('v1:') === 0) return container;
        }
        return '';
    }

    function calculateERPHash(job) {
        return $.ajax({
            url         : erpTechnologyProxyBaseUrl + 'hash',
            method      : 'POST',
            contentType : 'application/json',
            data        : JSON.stringify(buildERPHashInput(job))
        }).then(function(response) {
            let hash = getERPHashResponseValue(response);
            if(isBlank(hash)) {
                let responseShape = response && typeof response === 'object' ? Object.keys(response).join(', ') : typeof response;
                let dataShape = response && response.data && typeof response.data === 'object' ? Object.keys(response.data).join(', ') : typeof (response && response.data);
                throw new Error('Serwer nie zwrócił skrótu danych ERP. Format odpowiedzi: [' + responseShape + '], data: [' + dataShape + '].');
            }
            job.erpHash = hash;
            job.erpOutOfDate = job.erpHash !== job.storedERPHash;
            return job;
        });
    }

    function buildERPSyncBOMTechnologyJob(part, isMainRoot) {
        let operations = part.erpChildren.filter(isERPSyncBOMOperation);
        if(operations.length === 0) return null;

        let technologyVersionId = getERPSyncBOMVersionId(part);
        let productState = getERPSyncBOMProductState(part);
        let technologySynced = !isBlank(technologyVersionId);
        let assemblyIndex = isAssemblyIndexNode(part);
        let rawIndex = getERPSyncBOMValue(part, ['NUMBER'], part.partNumber || '');
        let description = getERPSyncBOMValue(part, ['OPIS'], getERPSyncBOMValue(part, ['TITLE'], part.title || ''));
        let technologyId = getERPSyncBOMValue(part, ['ID_TECHNOLOGI'], '');
        let revision = getERPSyncBOMRevision(part);
        let revisionDescription = isBlank(revision) ? '' : 'Rewizja: ' + revision;
        let payload = {
            indeks          : normalizeERPTechnologyIndex(rawIndex),
            nazwa_czesci    : getERPSyncBOMValue(part, ['NAZWA_DEFRO', 'TITLE'], part.title || ''),
            opis            : [description, technologyId, revisionDescription].filter(function(value) { return !isBlank(value); }).join(' | '),
            rewizja         : revision,
            czy_zatwierdzona: 'N',
            wlasnosci       : [],
            operacje        : [],
            struktura       : [],
            zalaczniki      : getERPTechnologyAttachments(part.link)
        };


        erpTechnologyPropertyMappings.forEach(function(mapping) {
            let value = getERPSyncBOMValue(part, mapping[1], '');
            if(!isBlank(value)) {
                let property = {};
                property[mapping[0]] = value;
                payload.wlasnosci.push(property);
            }
        });

        operations.forEach(function(operation) {
            let processNumber = getERPSyncBOMProcessNumber(operation);
            payload.operacje.push({
                numer_operacji : processNumber,
                kod_operacji   : getERPSyncBOMValue(operation, erpTechnologyOperationCodeCandidates, operation.title || ''),
                gniazdo        : 'xxxx',
                stanowisko     : 'wirtualne'
            });

            operation.erpChildren.filter(function(child) { return !isERPSyncBOMOperation(child); }).forEach(function(component) {
                let fieldIds = config.workspaceMBOM.fieldIDs || {};
                let componentIndex = getERPSyncBOMValue(component, [customERPFieldIDs.partIndex, fieldIds.number, 'NUMBER'], component.partNumber || '');
                let type = String(getERPSyncBOMValue(component, [fieldIds.type, 'TYPE'], '')).trim().toLowerCase();
                let componentVersionId = getERPSyncBOMVersionId(component);
                let structureRow = {
                    numer_operacji  : processNumber,
                    indeks_skladowy : normalizeERPTechnologyIndex(componentIndex),
                    rewizja         : type === 'manufacturing' ? getERPSyncBOMRevision(component) : '',
                    ilosc_stala     : 0,
                    ilosc_jednostek : Number(component.quantity) || 1,
                    jednostka_miary : getERPSyncBOMUnitOfMeasure(component)
                };
                if(!isBlank(componentVersionId)) structureRow.id_wersji_skladowej = componentVersionId;
                payload.struktura.push(structureRow);
            });
        });

        sortERPTechnologyOperations(payload);
        sortERPTechnologyStructure(payload);

        return {
            jobType           : 'technology',
            elemItem          : $(),
            link              : part.link,
            descriptor        : part.title || rawIndex,
            level             : Number(part.level) || 0,
            synced            : technologySynced,
            isMainRoot        : isMainRoot,
            isAssemblyIndex   : assemblyIndex,
            productRequired   : !productState.productExists,
            productPayload    : productState.productExists ? null : buildERPSyncBOMProductPayload(part, assemblyIndex),
            productHashPayload: buildERPSyncBOMProductPayload(part, assemblyIndex),
            productSourceLink : part.link,
            productIndexToCopy: '',
            productUpdateMode : productState.updateMode,
            payload           : payload,
            storedERPHash     : getERPSyncBOMStoredHash(part),
            erpSyncStatus     : getERPSyncBOMStatus(part)
        };
    }

    function collectERPTechnologyJobs(options) {
        options = options || {};
        let revisionBias = options.revisionBias || 'working';
        return loadERPSyncBOMParts(revisionBias).then(function(parts) {
            let productJobs = [];
            let productLinks = new Set();

            parts.forEach(function(part, index) {
                if(index === 0 || isERPSyncBOMOperation(part) || isERPSyncBOMManufacturing(part)) return;
                let linkKey = normalizePLMLink(part.link);
                if(isBlank(linkKey) || productLinks.has(linkKey)) return;
                productLinks.add(linkKey);
                let productState = getERPSyncBOMProductState(part);

                let assemblyIndex = isAssemblyIndexNode(part);
                let fieldIds = config.workspaceMBOM.fieldIDs || {};
                productJobs.push({
                    jobType           : 'product',
                    elemItem          : $(),
                    link              : part.link,
                    descriptor        : part.title || part.partNumber || '',
                    level             : Number(part.level) || 0,
                    productRequired   : !productState.productExists,
                    productPayload    : buildERPSyncBOMProductPayload(part, assemblyIndex),
                    productSourceLink : part.link,
                    productIndexToCopy: '',
                    productUpdateMode : productState.updateMode,
                    storedERPHash     : getERPSyncBOMStoredHash(part),
                    erpSyncStatus     : getERPSyncBOMStatus(part),
                    componentType    : String(getERPSyncBOMValue(part, [fieldIds.type, 'TYPE'], '') || '')
                });
            });

            let technologyJobs = parts.map(function(part, index) {
                return buildERPSyncBOMTechnologyJob(part, index === 0);
            }).filter(function(job) {
                return !!job && !!job.payload && !isBlank(job.payload.indeks) && job.payload.operacje.length > 0;
            });

            let componentWarnings = productJobs.filter(function(job) {
                    return job.erpSyncStatus !== 'UP_TO_DATE';
                }).map(function(job) {
                    let status = job.erpSyncStatus === 'OUT_OF_DATE' ? 'OUT_OF_DATE' : 'NOT_SYNCED';
                    return {
                        descriptor : job.descriptor,
                        link       : job.link,
                        type       : job.componentType || 'Komponent',
                        status     : status
                    };
                });

            if(componentWarnings.length > 0) {
                let warning = new Error('Komponenty inne niz Manufacturing musza zostac najpierw zsynchronizowane przez ERP Interface.');
                warning.erpComponentWarnings = componentWarnings;
                throw warning;
            }

            let hashPromise = options.calculateHashes === false ? Promise.resolve(technologyJobs) : Promise.all(technologyJobs.map(calculateERPHash));

            return hashPromise.then(function(hashedJobs) {
                let requiredTechnologies = options.calculateHashes === false
                    ? hashedJobs
                    : hashedJobs.filter(function(job) {
                        return job.productRequired || !job.synced || job.erpOutOfDate || job.erpSyncStatus !== 'UP_TO_DATE';
                    });

                console.log('MBOM custom: ERP jobs built from one ERP Sync BOM response', {
                    parts        : parts.length,
                    products     : 0,
                    technologies : requiredTechnologies.length
                });

                return orderERPTechnologyJobsBottomUp(requiredTechnologies);
            });
        });
    }

    function previewERPTechnologies() {
        let elemButton = $('#preview-erp-technologies');
        if(elemButton.hasClass('disabled')) return;

        elemButton.addClass('disabled').text('Przygotowywanie…');
        setERPStatusOutput('Przygotowywanie danych technologii ERP', {
            timestamp : new Date().toISOString()
        }, false);

        collectERPTechnologyJobs().then(function(jobs) {
            if(jobs.length === 0) {
                setERPStatusOutput('Nie znaleziono danych technologii ERP', {
                    message : 'Bieżący mBOM nie zawiera technologii opartych na operacjach ani produktów wymagających wysłania.'
                }, true);
                return;
            }

            let previewItems = [];

            jobs.forEach(function(job) {
                if(job.jobType === 'product') {
                    previewItems.push({
                        order      : previewItems.length + 1,
                        callName   : 'add-product',
                        indeks     : job.productPayload ? job.productPayload.indeks : '',
                        descriptor : job.descriptor,
                        payload    : job.productPayload
                    });
                    return;
                }

                if(job.productRequired) {
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
                    callName   : 'add-technology',
                    indeks     : job.payload.indeks,
                    descriptor : job.descriptor,
                    payload    : job.payload
                });
            });

            setERPStatusOutput('Podgląd danych technologii ERP', {
                requestCount : previewItems.length,
                message      : 'Bieżący mBOM wyśle do ERP następującą liczbę żądań: ' + previewItems.length + '.',
                requests     : previewItems
            }, false);
        }).catch(function(error) {
            console.warn('MBOM custom: failed to build ERP technology payloads', error);
            setERPStatusOutput(error && error.erpComponentWarnings
                ? 'Najpierw zsynchronizuj komponenty w ERP Interface'
                : 'Nie udało się przygotować danych technologii ERP', {
                error      : String(error && error.message ? error.message : error || ''),
                komponenty : error && error.erpComponentWarnings ? error.erpComponentWarnings : undefined
            }, true);
        }).finally(function() {
            elemButton.removeClass('disabled').text('Podgląd JSON technologii');
        });
    }

    function updateERPSyncFields(link, erpResponseBody, updateMode, erpHash) {
        if(isBlank(link)) {
            return Promise.resolve(false);
        }

        let isTechnologyUpdate = updateMode === 'technology';
        let isProductUpdate = updateMode === 'product';
        let workspaceConfig = (typeof config !== 'undefined' && config.workspaceMBOM) ? config.workspaceMBOM : null;
        let fieldIds = workspaceConfig && workspaceConfig.fieldIDs
            ? workspaceConfig.fieldIDs
            : {};
        let fieldIdERPVersion = customERPFieldIDs.versionId;
        let fieldIdERPPartIndex = customERPFieldIDs.partIndex;
        let fieldIdERPHash = customERPFieldIDs.hash;

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

        let sectionsPromise = (typeof wsMBOM !== 'undefined' && Array.isArray(wsMBOM.sections) && wsMBOM.sections.length > 0)
            ? Promise.resolve({ data : wsMBOM.sections })
            : $.get('/plm/sections', { link : link });

        return sectionsPromise.then(function(response) {
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

            if((isTechnologyUpdate || isProductUpdate) && !isBlank(erpHash)) {
                addERPField(fieldIdERPHash, 'pending:' + String(erpHash).replace(/^pending:/, ''));
            }
            if(erpResponseBody && typeof erpResponseBody === 'object') {
                if(isTechnologyUpdate) {
                    let versionId = normalizeERPIntegerValue(erpResponseBody.id_wersji);
                    if(!isBlank(versionId)) addERPField(fieldIdERPVersion, versionId, 'integer');
                }
                let partIndex = normalizeERPTextValue(erpResponseBody.indeks_czesci);
                if(!isBlank(partIndex)) addERPField(fieldIdERPPartIndex, partIndex);
            }

            if(fieldsRequested.length === 0) return false;

            console.log('MBOM custom: updating ERP sync fields with resolved section payload', {
                link            : link,
                updateMode      : updateMode,
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
                updateMode      : updateMode,
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
            message      : message || 'Żądanie ERP nie powiodło się.',
            requestDump  : responseData.requestDumpUrl || '',
            responseDump : responseData.dumpUrl || ''
        };
    }

    function ensureERPProductPrerequisite(currentJob, testRun, results) {
        if(!currentJob || !currentJob.productRequired) {
            if(!currentJob || testRun || isBlank(currentJob.productIndexToCopy) || isBlank(currentJob.link)) {
                return Promise.resolve(true);
            }

            return updateERPSyncFields(currentJob.link, {
                indeks_czesci : currentJob.productIndexToCopy
            }, 'index').then(function(updated) {
                if(updated) erpTechnologyDetailsCache = {};
                return true;
            });
        }

        let payload = currentJob.productPayload || {};
        let missingFields = [];

        if(isBlank(payload.indeks)) missingFields.push('NUMBER -> indeks');
        if(isBlank(payload.nazwa_czesci)) missingFields.push('NAZWA_DEFRO/TITLE -> nazwa_czesci');
        if(isBlank(payload.id_grupy)) missingFields.push('GRUPA_PRODUKTOWA -> id_grupy');

        if(missingFields.length > 0) {
            results.push({
                order      : results.length + 1,
                callName   : 'add-product',
                indeks     : payload.indeks || '',
                descriptor : currentJob.descriptor,
                testRun    : testRun,
                success    : false,
                error      : 'Dane produktu ERP są niekompletne: ' + missingFields.join(', ')
            });
            return Promise.resolve(false);
        }

        let callName = 'add-product';
        let requestUrl = testRun
            ? erpTechnologyProxyBaseUrl + 'export-request/' + callName
            : erpTechnologyProxyBaseUrl + callName;

        console.log('MBOM custom: sending ERP product prerequisite', {
            testRun    : testRun,
            callName   : callName,
            indeks     : payload.indeks,
            sourceLink : currentJob.productSourceLink || currentJob.link,
            descriptor : currentJob.descriptor
        });

        return $.post(requestUrl, payload, null, 'json').then(function(response) {
            let status = Number(response && response.status);
            let success = !!response && !response.error && status === 200;

            let erpResponseBody = response && response.data ? response.data.body : null;
            let indexUpdatePromise = Promise.resolve(false);
            if(!testRun && success) {
                let updateRequests = [];
                let productSourceLink = currentJob.productSourceLink || currentJob.link;

                updateRequests.push(updateERPSyncFields(
                    productSourceLink,
                    erpResponseBody,
                    currentJob.productUpdateMode || 'product',
                    currentJob.productUpdateMode === 'product' ? currentJob.erpHash : ''
                ));
                if(normalizePLMLink(productSourceLink) !== normalizePLMLink(currentJob.link)) {
                    updateRequests.push(updateERPSyncFields(currentJob.link, erpResponseBody, 'index'));
                }

                indexUpdatePromise = Promise.all(updateRequests).then(function(updates) {
                    return updates.some(function(updated) { return updated === true; });
                });
            }

            return indexUpdatePromise.then(function(indexUpdated) {
                if(indexUpdated) erpTechnologyDetailsCache = {};

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
                    indexUpdated: indexUpdated,
                    erpHash     : currentJob.erpHash || '',
                    error       : success ? '' : ((response && response.message) || 'Operacja ERP add-product nie zwróciła statusu 200.')
                });

                return success;
            });
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

    function ensureERPSyncProgressDialog() {
        let elemDialog = $('#dialog-erp-sync');
        if(elemDialog.length > 0) return elemDialog;

        elemDialog = $('<div></div>')
            .attr('id', 'dialog-erp-sync')
            .addClass('dialog')
            .appendTo('body');

        $('<div></div>')
            .addClass('dialog-header')
            .text('Synchronizacja technologii ERP')
            .appendTo(elemDialog);

        let elemContent = $('<div></div>')
            .addClass('dialog-content')
            .appendTo(elemDialog);

        function addProgressStep(id, label) {
            let elemStep = $('<div></div>')
                .attr('id', id)
                .addClass('step')
                .appendTo(elemContent);

            $('<div></div>')
                .addClass('step-label')
                .text(label)
                .appendTo(elemStep);

            let elemProgress = $('<div></div>')
                .addClass('step-progress')
                .appendTo(elemStep);

            $('<div></div>')
                .attr('id', id + '-bar')
                .addClass('step-bar')
                .appendTo(elemProgress);

            $('<div></div>')
                .attr('id', id + '-counter')
                .addClass('step-counter')
                .appendTo(elemStep);
        }

        addProgressStep('erp-step-reading', 'Odczytywanie mBOM');
        addProgressStep('erp-step-sending', 'Wysyłanie do ERP');

        let elemFooter = $('<div></div>')
            .addClass('dialog-footer')
            .appendTo(elemDialog);

        $('<div></div>')
            .attr('id', 'confirm-erp-sync')
            .addClass('button disabled')
            .text('Zamknij')
            .click(function() {
                if($(this).hasClass('disabled')) return;
                elemDialog.hide();
                $('#overlay').hide();
            })
            .appendTo(elemFooter);

        return elemDialog;
    }

    function showERPSyncProgressDialog() {
        let elemDialog = ensureERPSyncProgressDialog();

        elemDialog.find('.dialog-header').text('Synchronizacja technologii ERP');
        elemDialog.find('.step').removeClass('in-work');
        elemDialog.find('.step-bar')
            .addClass('transition-stopper')
            .css('width', '0%')
            .removeClass('transition-stopper');

        $('#erp-step-reading').addClass('in-work');
        $('#erp-step-reading-counter').text('Odczytywanie');
        $('#erp-step-sending-counter').text('Oczekiwanie');
        $('#confirm-erp-sync').addClass('disabled').removeClass('default');

        $('#overlay').show();
        elemDialog.show();
    }

    function startERPSyncSendingProgress(total) {
        let count = Number(total) || 0;

        $('#erp-step-reading').removeClass('in-work');
        $('#erp-step-reading-bar').css('width', '100%');
        $('#erp-step-reading-counter').text('Gotowe');
        $('#erp-step-sending').addClass('in-work');
        $('#erp-step-sending-bar').css('width', '0%');
        $('#erp-step-sending-counter').text('0 z ' + count);
    }

    function updateERPSyncSendingProgress(current, total) {
        let done = Number(current) || 0;
        let count = Number(total) || 0;
        let progress = count > 0 ? Math.min(100, done * 100 / count) : 100;

        $('#erp-step-sending-bar').css('width', progress + '%');
        $('#erp-step-sending-counter').text(done + ' z ' + count);
    }

    function completeERPSyncProgressDialog(total, failed) {
        let count = Number(total) || 0;

        $('#erp-step-reading').removeClass('in-work');
        $('#erp-step-reading-bar').css('width', '100%');
        $('#erp-step-reading-counter').text('Gotowe');
        $('#erp-step-sending').removeClass('in-work');
        $('#erp-step-sending-bar').css('width', '100%');
        $('#erp-step-sending-counter').text(count + ' z ' + count);
        $('#dialog-erp-sync .dialog-header').text(failed ? 'Synchronizacja technologii ERP nie powiodła się' : 'Synchronizacja technologii ERP zakończona');
        $('#confirm-erp-sync').removeClass('disabled').addClass('default');
    }

    function addERPProductJobsToAffectedItems(productJobs, testRun) {
        if(testRun || !Array.isArray(productJobs) || productJobs.length === 0) {
            return Promise.resolve({ added : 0 });
        }

        return syncMBOMChangeOrderAfterSave().then(function(changeOrderResult) {
            if(!changeOrderResult || isBlank(changeOrderResult.release)) {
                return { added : 0, skipped : true };
            }
            return changeOrderResult.add || { added : 0 };
        });
    }

    function syncERPTechnologies() {
        let elemButton = $('#sync-erp-technologies');
        if(elemButton.hasClass('disabled')) return;
        let testRun = isERPTechnologyTestRunEnabled();
        let totalJobs = 0;

        elemButton.addClass('disabled').text('Synchronizacja…');
        showERPSyncProgressDialog();
        setERPStatusOutput(testRun ? 'Eksport żądań technologii ERP do JSON' : 'Synchronizacja technologii ERP', {
            timestamp : new Date().toISOString(),
            testRun   : testRun
        }, false);

        collectERPTechnologyJobs().then(function(jobs) {
            totalJobs = jobs.length;
            startERPSyncSendingProgress(totalJobs);

            if(jobs.length === 0) {
                setERPStatusOutput('Nie znaleziono danych do synchronizacji ERP', {
                    message : 'Bieżący mBOM nie zawiera technologii opartych na operacjach ani produktów wymagających wysłania.'
                }, true);
                completeERPSyncProgressDialog(totalJobs, true);
                return;
            }

            let productJobs = jobs.filter(function(job) { return job.jobType === 'product'; });
            return addERPProductJobsToAffectedItems(productJobs, testRun).then(function() {
            let results = [];
            let chain = Promise.resolve();
            let completedJobs = 0;
            let allProductsReady = true;

            jobs.forEach(function(job, index) {
                chain = chain.then(function() {
                    // The PLM payload was already built during the bounded parallel
                    // discovery phase. Reuse it so ERP requests stay sequential
                    // without repeating all PLM detail and structure reads.
                    return Promise.resolve(job).then(function(currentJob) {
                        if(currentJob && currentJob.jobType === 'product') {
                            return ensureERPProductPrerequisite(currentJob, testRun, results).then(function(productReady) {
                                if(!productReady) allProductsReady = false;
                                return null;
                            });
                        }

                        if(!allProductsReady) {
                            results.push({
                                order      : results.length + 1,
                                callName   : 'skipped-technology',
                                indeks     : currentJob && currentJob.payload ? currentJob.payload.indeks : '',
                                descriptor : currentJob ? currentJob.descriptor : '',
                                success    : false,
                                error      : 'Nie wszystkie komponenty istnieją w ERP. Synchronizacja technologii została pominięta.'
                            });
                            return null;
                        }

                        if(!currentJob || !currentJob.payload || isBlank(currentJob.payload.indeks) || !Array.isArray(currentJob.payload.operacje) || currentJob.payload.operacje.length === 0) {
                            results.push({
                                order      : results.length + 1,
                                callName   : 'skipped',
                                indeks     : '',
                                descriptor : getERPTechnologyDescriptor(job.elemItem),
                                success    : false,
                                error      : 'Nie udało się ponownie przygotować danych technologii ERP przed wysłaniem.'
                            });
                            return null;
                        }

                        return ensureERPProductPrerequisite(currentJob, testRun, results).then(function(productReady) {
                            if(!productReady) {
                                console.warn('MBOM custom: skipping ERP technology because its product prerequisite failed', {
                                    indeks     : currentJob.productPayload ? currentJob.productPayload.indeks : '',
                                    descriptor : currentJob.descriptor
                                });
                                return null;
                            }

                            let callName = 'add-technology';
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
                                    ? updateERPSyncFields(
                                        currentJob.link,
                                        erpResponseBody,
                                        'technology',
                                        currentJob.erpHash
                                    )
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
                                    erpHash     : currentJob.erpHash || '',
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
                }).then(function() {
                    completedJobs++;
                    updateERPSyncSendingProgress(completedJobs, totalJobs);
                });
            });

            return chain.then(function() {
                renderERPTechnologySyncResults(
                    testRun ? 'Eksport żądań technologii ERP zakończony' : 'Synchronizacja technologii ERP zakończona',
                    results,
                    results.some(function(result) { return !result.success; }),
                    testRun
                );
                completeERPSyncProgressDialog(
                    totalJobs,
                    results.some(function(result) { return !result.success; })
                );
            });
            });
        }).catch(function(error) {
            console.warn('MBOM custom: ERP technology sync failed', error);
            setERPStatusOutput(error && error.erpComponentWarnings
                ? 'Synchronizacja zablokowana - komponenty wymagają synchronizacji'
                : 'Synchronizacja technologii ERP nie powiodła się', {
                error      : String(error && error.message ? error.message : error || ''),
                komponenty : error && error.erpComponentWarnings ? error.erpComponentWarnings : undefined
            }, true);
            completeERPSyncProgressDialog(totalJobs, true);
        }).finally(function() {
            elemButton.removeClass('disabled').text('Synchronizuj technologię z ERP');
        });
    }


    function getERPTechnologyResponseVersionId(responseBody) {
        if(!responseBody || typeof responseBody !== 'object') return '';
        let value = responseBody.id_wersji;
        if(isBlank(value)) value = responseBody.ID_WERSJI;
        let number = Number(value);
        return isBlank(value) || Number.isNaN(number) ? '' : Math.trunc(number);
    }

    function applyERPChildTechnologyVersions(job, versionByIndex) {
        if(!job || !job.payload || !Array.isArray(job.payload.struktura)) return;
        job.payload.struktura.forEach(function(row) {
            let index = String(row.indeks_skladowy || '');
            if(Object.prototype.hasOwnProperty.call(versionByIndex, index)) {
                row.id_wersji_skladowej = versionByIndex[index];
            }
        });
    }

    function sendReleasedMBOMTechnologiesToERP(onProgress) {
        let results = [];
        let versionByIndex = {};

        return collectERPTechnologyJobs({
            revisionBias    : 'release',
            calculateHashes : false
        }).then(function(jobs) {
            if(jobs.length === 0) throw new Error('Po zwolnieniu nie znaleziono żadnych technologii mBOM do wysłania do Impuls.');
            if(typeof onProgress === 'function') onProgress(0, jobs.length, 'Wczytano zwolnione rewizje mBOM.');

            let chain = Promise.resolve();
            jobs.forEach(function(job, index) {
                chain = chain.then(function() {
                    applyERPChildTechnologyVersions(job, versionByIndex);
                    return calculateERPHash(job);
                }).then(function(currentJob) {
                    return ensureERPProductPrerequisite(currentJob, false, results).then(function(productReady) {
                        if(!productReady) throw new Error('Nie udało się przygotować produktu ERP dla „' + currentJob.descriptor + '”.');

                        return $.post(erpTechnologyProxyBaseUrl + 'add-technology', currentJob.payload, null, 'json').then(function(response) {
                            let status = Number(response && response.status);
                            let success = !!response && !response.error && status === 200;
                            let responseBody = response && response.data ? response.data.body : null;

                            if(!success) {
                                throw new Error((response && response.message) || 'Impuls nie zwrócił statusu 200 dla „' + currentJob.descriptor + '”.');
                            }

                            return updateERPSyncFields(
                                currentJob.link,
                                responseBody,
                                'technology',
                                currentJob.erpHash
                            ).then(function(updated) {
                                if(!updated) throw new Error('Nie udało się zapisać wyniku synchronizacji ERP w PLM dla „' + currentJob.descriptor + '”.');

                                let newVersionId = getERPTechnologyResponseVersionId(responseBody);
                                if(!isBlank(newVersionId)) versionByIndex[String(currentJob.payload.indeks || '')] = newVersionId;

                                results.push({
                                    order       : results.length + 1,
                                    callName    : 'add-technology',
                                    indeks      : currentJob.payload.indeks,
                                    descriptor  : currentJob.descriptor,
                                    revision    : currentJob.payload.rewizja,
                                    status      : status,
                                    success     : true,
                                    requestDump : response && response.data ? response.data.requestDumpUrl : '',
                                    responseDump: response && response.data ? response.data.dumpUrl : '',
                                    erpHash     : currentJob.erpHash,
                                    erpVersionId: newVersionId
                                });
                            });
                        });
                    });
                }).then(function() {
                    if(typeof onProgress === 'function') onProgress(index + 1, jobs.length, 'Wysłano „' + job.descriptor + '”.');
                }).catch(function(error) {
                    let failure = getERPRequestFailureDetails(error);
                    results.push({
                        order      : results.length + 1,
                        callName   : 'add-technology',
                        indeks     : job && job.payload ? job.payload.indeks : '',
                        descriptor : job ? job.descriptor : '',
                        revision   : job && job.payload ? job.payload.rewizja : '',
                        success    : false,
                        error      : error && error.message ? error.message : failure.message
                    });
                    error.erpResults = results;
                    throw error;
                });
            });

            return chain.then(function() {
                return { jobs : jobs, results : results };
            });
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

            html += '<div class="erp-status-line">Znaleziono kolejny rekord do przetworzenia</div>';
            html += '<div class="erp-status-line">– Przetwarzanie „' + descriptor + '”</div>';

            if(result.success) {
                html += '<div class="erp-status-line">Operacja ERP ' + callName + ' zakończona powodzeniem dla „' + descriptor + '”</div>';
            } else {
                html += '<div class="erp-status-line error">Operacja ERP ' + callName + ' nie powiodła się dla „' + descriptor + '”</div>';
            }

            if(result.requestDump) {
                html += '<div class="erp-status-line">Plik żądania ERP: <a target="_blank" href="' + escapeERPStatusHtml(result.requestDump) + '">Otwórz JSON żądania</a></div>';
            }

            if(testRun && result.erpHash) {
                html += '<div class="erp-status-line">Wyliczony ERP_HASH: ' + escapeERPStatusHtml(result.erpHash) + '</div>';
                html += '<div class="erp-status-line">Przewidywany wynik onEdit: ERP_SYNC_STATUS = UP_TO_DATE, ERP_SYNC_DATE = bieżąca data i czas.</div>';
                html += '<div class="erp-status-line">Tryb testowy nie zmienił żadnych pól w PLM.</div>';
            }

            if(!testRun && result.responseDump) {
                html += '<div class="erp-status-line">Plik odpowiedzi ERP: <a target="_blank" href="' + escapeERPStatusHtml(result.responseDump) + '">Otwórz JSON odpowiedzi</a></div>';
            }

            if(result.error) {
                html += '<div class="erp-status-line error">Błąd: ' + escapeERPStatusHtml(result.error) + '</div>';
            }

            html += '<div class="erp-status-line">&nbsp;</div>';
        });

        html += '<div class="erp-status-line"><strong>PODSUMOWANIE</strong></div>';
        html += '<div class="erp-status-line">Operacje zakończone powodzeniem: ' + successCount + '</div>';
        html += '<div class="erp-status-line">Operacje zakończone błędem: ' + failedCount + '</div>';
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
                elemButton.text('Kopiuj odpowiedź');
            }, 1500);
        };

        if(navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(text)
                .then(function() {
                    setCopiedState('Skopiowano');
                })
                .catch(function() {
                    window.getSelection().removeAllRanges();
                    let range = document.createRange();
                    range.selectNodeContents(elemOutput[0]);
                    window.getSelection().addRange(range);
                    setCopiedState('Zaznacz i skopiuj');
                });
            return;
        }

        window.getSelection().removeAllRanges();
        let range = document.createRange();
        range.selectNodeContents(elemOutput[0]);
        window.getSelection().addRange(range);
        setCopiedState('Zaznacz i skopiuj');
    }

    function checkERPStatus() {
        let elemButton = $('#check-erp-status');
        if(elemButton.hasClass('disabled')) return;

        elemButton.addClass('disabled').text('Sprawdzanie…');
        setERPStatusOutput('Sprawdzanie statusu ERP', {
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

            setERPStatusOutput('Sprawdzenie statusu ERP zakończone powodzeniem', payload, false);
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

            setERPStatusOutput('Sprawdzenie statusu ERP nie powiodło się', payload || {
                httpStatus : jqXHR.status || null,
                statusText : textStatus,
                error      : errorThrown || ''
            }, true);
        }).always(function() {
            elemButton.removeClass('disabled').text('Sprawdź status ERP');
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
            .text('Integracja ERP');

        $('<div></div>')
            .appendTo(elemPanel)
            .addClass('erp-description')
            .text('Sprawdź połączenie i odpowiedź punktu końcowego ERP.');

        $('<div></div>')
            .appendTo(elemPanel)
            .attr('id', 'toggle-erp-technology-test-run')
            .addClass('button')
            .addClass('with-icon')
            .addClass('icon-toggle-on')
            .addClass('filled')
            .text('Tylko przebieg testowy')
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
            .text('Podgląd JSON technologii')
            .click(previewERPTechnologies);

        $('<div></div>')
            .appendTo(elemPanel)
            .attr('id', 'sync-erp-technologies')
            .addClass('button')
            .addClass('default')
            .text('Synchronizuj technologię z ERP')
            .click(syncERPTechnologies);

        $('<div></div>')
            .appendTo(elemPanel)
            .attr('id', 'check-erp-status')
            .addClass('button')
            .text('Sprawdź status ERP')
            .click(checkERPStatus);

        $('<div></div>')
            .appendTo(elemPanel)
            .attr('id', 'copy-erp-status')
            .addClass('button')
            .text('Kopiuj odpowiedź')
            .click(copyERPStatusOutput);

        $('<div></div>')
            .appendTo(elemPanel)
            .attr('id', 'erp-status-output')
            .addClass('erp-status-output')
            .html('<pre>W tym miejscu pojawi się odpowiedź ERP.</pre>');

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

    function getMBOMPropertyRepairMappings() {
        let configuredMappings = (typeof config !== 'undefined' && config.mbomRoot && Array.isArray(config.mbomRoot.fieldsToCopy))
            ? config.mbomRoot.fieldsToCopy : [];

        let mappings = configuredMappings.filter(function(mapping) {
            return mapping && !isBlank(mapping.ebom) && !isBlank(mapping.mbom);
        });

        return mappings;
    }

    function getMBOMPropertyRepairSourceLink(detailsData) {
        let sections = detailsData && Array.isArray(detailsData.sections) ? detailsData.sections : [];
        let fieldId = config.workspaceMBOM.fieldIDs.ebom;
        return getBOMLinkedFieldLink(getSectionFieldValue(sections, fieldId, '', 'object'));
    }

    function isMBOMPropertyRepairManufacturingType(value) {
        if(isBlank(value)) return false;

        let configuredTypeLink = (config.mbomRoot && config.mbomRoot.typeValue) ? config.mbomRoot.typeValue : '';
        let valueLink = getBOMLinkedFieldLink(value);
        if(!isBlank(configuredTypeLink)) {
            return !isBlank(valueLink)
                && String(configuredTypeLink).toLowerCase() === String(valueLink).toLowerCase();
        }

        let title = '';
        if(typeof value === 'string') title = value;
        else if(value && typeof value.title === 'string') title = value.title;
        else if(value && typeof value.label === 'string') title = value.label;

        return title.trim().toLowerCase() === 'manufacturing';
    }

    function isMBOMPropertyRepairTarget(detailsData, targetLink, sourceLink) {
        if(!detailsData || !Array.isArray(detailsData.sections)) return false;
        if(normalizePLMLink(targetLink) === normalizePLMLink(sourceLink)) return false;

        let typeValue = getSectionFieldValue(
            detailsData.sections,
            config.workspaceMBOM.fieldIDs.type,
            '',
            'object'
        );

        let linkedSource = getMBOMPropertyRepairSourceLink(detailsData);
        return isMBOMPropertyRepairManufacturingType(typeValue)
            && normalizePLMLink(linkedSource) === normalizePLMLink(sourceLink);
    }

    function getLoadedMBOMPropertyRepairTarget(part) {
        if(!part) return '';

        let values = [part.mbom];
        let fieldId = config.workspaceEBOM.fieldIDs.mbom;
        let contextFieldId = (typeof urlParameters !== 'undefined') ? urlParameters.contextfieldidmbom : '';
        let suffix = (typeof siteSuffix !== 'undefined') ? siteSuffix : '';
        let fieldIds = [contextFieldId + suffix, contextFieldId, fieldId + suffix, fieldId];

        if(Array.isArray(part.fields)) {
            fieldIds.forEach(function(candidate) {
                if(!isBlank(candidate)) values.push(getBOMPartFieldValue(part, candidate));
            });
        }

        for(let value of values) {
            let link = getBOMLinkedFieldLink(value);
            if(!isBlank(link)) return getPLMItemLevelLink(link);
        }

        return '';
    }

    function loadMBOMPropertyRepairDetails(link, label) {
        return $.get('/plm/details', { link : link }).then(function(response) {
            if(!response || response.error || !response.data) {
                throw new Error((response && response.message) || 'Could not load ' + label + ' details.');
            }
            return response.data;
        });
    }

    function buildMBOMPropertyRepairFields(sourceSections, mappings) {
        let fields = [];

        mappings.forEach(function(mapping) {
            let value = getSectionFieldValue(sourceSections, mapping.ebom, null);
            if(!isBlank(value)) fields.push({ fieldId : mapping.mbom, value : value });
        });

        if(fields.length === 0) return fields;

        let timestamp = new Date();
        let syncDate = timestamp.getFullYear() + '-' + (timestamp.getMonth() + 1) + '-' + timestamp.getDate();

        if(!isBlank(config.workspaceMBOM.fieldIDs.lastMBOMSync)) {
            fields.push({ fieldId : config.workspaceMBOM.fieldIDs.lastMBOMSync, value : syncDate });
        }
        if(!isBlank(config.workspaceMBOM.fieldIDs.lastMBOMUser) &&
            typeof userAccount !== 'undefined' && !isBlank(userAccount.displayName)) {
            fields.push({ fieldId : config.workspaceMBOM.fieldIDs.lastMBOMUser, value : userAccount.displayName });
        }

        return fields;
    }

    function repairMBOMPropertiesFromEBOM(sourceEBOMLink, mappings, results, options) {
        let sourceData;
        let sourceLink;
        let targetLink;

        return loadMBOMPropertyRepairDetails(sourceEBOMLink, 'source eBOM').then(function(data) {
            sourceData = data;
            sourceLink = getPLMItemLevelLink(data.__self__ || sourceEBOMLink);
            targetLink = getPLMItemLevelLink(getConfiguredMBOMLinkFromDetails(data));

            if(isBlank(targetLink)) {
                results.skipped++;
                return null;
            }
            if(normalizePLMLink(targetLink) === normalizePLMLink(sourceLink)) {
                throw new Error('Safety check refused an mBOM relationship that points to the source eBOM itself.');
            }

            return loadMBOMPropertyRepairDetails(targetLink, 'target mBOM');
        }).then(async function(targetData) {
            if(!targetData) return;

            let verifiedTargetLink = getPLMItemLevelLink(targetData.__self__ || targetLink);
            if(normalizePLMLink(verifiedTargetLink) !== normalizePLMLink(targetLink)) {
                throw new Error('Safety check refused an mBOM response whose item link does not match the requested target.');
            }
            if(!isMBOMPropertyRepairTarget(targetData, verifiedTargetLink, sourceLink)) {
                throw new Error('Safety check refused the target: it is not a distinct Manufacturing mBOM linked back to this eBOM.');
            }

            let fields = buildMBOMPropertyRepairFields(sourceData.sections || [], mappings);
            if(options && options.copiedFieldsOnly) {
                let copiedFieldIds = new Set(mappings.map(function(mapping) { return mapping.mbom; }));
                fields = fields.filter(function(field) { return copiedFieldIds.has(field.fieldId); });
                if(fields.length === 0) {
                    results.skipped++;
                    return;
                }
            } else {
                let hasBom = await getSourceEBOMHasChildren(sourceData);
                fields = fields.filter(function(field) { return field.fieldId !== 'HAS_BOM'; });
                fields.push({ fieldId: 'HAS_BOM', value: hasBom });
            }

            console.info('MBOM custom: repairing properties EBOM -> MBOM', {
                sourceEBOM : sourceLink,
                targetMBOM : verifiedTargetLink,
                fieldIds   : fields.map(function(field) { return field.fieldId; })
            });

            return $.post('/plm/edit', {
                link     : verifiedTargetLink,
                sections : wsMBOM.sections,
                fields   : fields
            }).then(function(response) {
                if(response && response.error) {
                    throw new Error(response.message || 'PLM rejected the property update.');
                }
                results.updated++;
            });
        });
    }

    function saveMBOMCopiedPropertiesBeforeSave() {
        let mappings = getMBOMPropertyRepairMappings();
        if(mappings.length === 0) return Promise.resolve();

        let queue = [];
        let seenSources = new Set();
        function enqueueSource(link) {
            let normalizedLink = normalizePLMLink(link);
            if(isBlank(normalizedLink) || seenSources.has(normalizedLink)) return;
            seenSources.add(normalizedLink);
            queue.push(link);
        }

        enqueueSource((typeof links !== 'undefined') ? links.ebom : '');
        if(Array.isArray(ebomPartsList)) {
            ebomPartsList.forEach(function(part) {
                if(!part || isBlank(part.link) || isBlank(getLoadedMBOMPropertyRepairTarget(part))) return;
                enqueueSource(part.link);
            });
        }

        let results = { updated : 0, skipped : 0 };
        let concurrency = Math.max(1, Math.min(5, typeof maxRequests === 'number' ? maxRequests : 5));
        let started = Date.now();

        return mapPLMRequestsWithConcurrency(queue, concurrency, function(sourceEBOMLink) {
            return repairMBOMPropertiesFromEBOM(sourceEBOMLink, mappings, results, { copiedFieldsOnly : true });
        }).then(function() {
            console.log('MBOM custom: configured eBOM properties synchronized before save', {
                updated    : results.updated,
                skipped    : results.skipped,
                sourceCount: queue.length,
                concurrency: concurrency,
                durationMs : Date.now() - started
            });
        });
    }

    function runMBOMPropertyRepair() {
        let elemButton = $('#repair-mbom-properties');
        if(elemButton.hasClass('disabled')) return;

        let mappings = getMBOMPropertyRepairMappings();
        if(mappings.length === 0) {
            showErrorMessage('Repair mBOM properties', 'No fields are configured in mbomRoot.fieldsToCopy.');
            return;
        }

        if(!window.confirm('Copy the configured properties and refresh HAS_BOM from each related eBOM to the current mBOM and all discovered sub-mBOMs?')) return;

        let queue = [];
        let seenSources = new Set();
        let results = {
            scanned : 0,
            updated : 0,
            skipped : 0,
            errors  : []
        };

        function enqueueSource(link) {
            let normalizedLink = normalizePLMLink(link);
            if(isBlank(normalizedLink) || seenSources.has(normalizedLink)) return;

            seenSources.add(normalizedLink);
            queue.push(link);
        }

        enqueueSource((typeof links !== 'undefined') ? links.ebom : '');

        if(Array.isArray(ebomPartsList)) {
            ebomPartsList.forEach(function(part) {
                if(!part || isBlank(part.link) || isBlank(getLoadedMBOMPropertyRepairTarget(part))) return;
                enqueueSource(part.link);
            });
        }

        if(queue.length === 0) {
            showErrorMessage('Repair mBOM properties', 'The current eBOM and its components could not be determined.');
            return;
        }

        let saveWasDisabled = $('#save').hasClass('disabled');
        elemButton.addClass('disabled').text('Repairing...');
        $('#save').addClass('disabled');

        let totalSources = queue.length;
        let repairChain = Promise.resolve();

        queue.forEach(function(sourceEBOMLink, index) {
            repairChain = repairChain.then(function() {
                results.scanned++;
                elemButton.text('Repair ' + (index + 1) + ' / ' + totalSources);

                return repairMBOMPropertiesFromEBOM(sourceEBOMLink, mappings, results).catch(function(error) {
                    results.errors.push({ link : sourceEBOMLink, error : error });
                    console.warn('MBOM custom: property repair failed', sourceEBOMLink, error);
                });
            });
        });

        repairChain.then(function() {
            let summary = results.updated + ' mBOM(s) updated, '
                + results.skipped + ' skipped, '
                + results.errors.length + ' error(s).';

            console.log('MBOM custom: property repair completed', results);

            if(results.errors.length > 0) {
                showErrorMessage('mBOM property repair completed with errors', summary + ' See the browser console for details.');
            } else {
                showSuccessMessage('mBOM property repair completed', summary);
            }
        }).catch(function(error) {
            console.warn('MBOM custom: property repair stopped unexpectedly', error);
            showErrorMessage('Repair mBOM properties', String(error && error.message ? error.message : error));
        }).finally(function() {
            elemButton.removeClass('disabled').text('Repair mBOM');
            if(!saveWasDisabled) $('#save').removeClass('disabled');
        });
    }

    function insertMBOMPropertyRepairButton() {
        if($('#repair-mbom-properties').length > 0) return;

        let button = $('<div></div>')
            .attr('id', 'repair-mbom-properties')
            .addClass('button default')
            .attr('title', 'One-time copy of configured EBOM properties to this MBOM and all discovered sub-MBOMs')
            .text('Repair mBOM')
            .click(runMBOMPropertyRepair);

        if($('#header-toolbar').length) {
            $('#header-toolbar').find('#header-avatar').before(button);
        } else {
            $('body').append(button);
        }
    }

    async function expandFullMBOMWithBOM() {
        let processed = new Set();
        let detailsByLink = new Map();
        let failures = [];
        while(true) {
            // Track occurrences, not item links: parallel branches may use the same MBOM.
            let candidates = [];
            $('#mbom-tree .item').each(function() {
                let elemItem = $(this);
                if(hasMBOMShortcut(elemItem) && !processed.has(this)) candidates.push(elemItem);
            });
            if(candidates.length === 0) break;
            for(let elemItem of candidates) {
                processed.add(elemItem[0]);
                try {
                    let context = await resolveInlineSubMBOMContext(elemItem);
                    if(isBlank(context.expansionLink)) continue;
                    let link = normalizePLMLink(context.expansionLink);
                    let cyclic = false;
                    elemItem.parents('.item').each(function() {
                        if($(this).attr('data-full-bom-expansion-link') === link) cyclic = true;
                    });
                    if(cyclic) continue;
                    if(!detailsByLink.has(link)) {
                        detailsByLink.set(link, loadMBOMPropertyRepairDetails(context.expansionLink, 'mBOM'));
                    }
                    let details = await detailsByLink.get(link);
                    if(!isMBOMHasBOM(getSectionFieldValue(details.sections || [], 'HAS_BOM', false))) continue;
                    elemItem.attr('data-full-bom-expansion-link', link);

                    // A full BOM response can already contain this MBOM's children.
                    let renderedBOM = elemItem.children('.item-bom').first();
                    if(normalizePLMLink(elemItem.attr('data-link')) === link &&
                       renderedBOM.children('.item').length > 0) {
                        elemItem.attr('data-inline-submbom-loaded', 'true');
                    }
                    let expanded = await ensureInlineSubMBOMExpanded(elemItem);
                    if(!expanded && elemItem.attr('data-inline-submbom-loaded') !== 'empty') {
                        throw new Error('Could not load sub-MBOM ' + context.expansionLink + '. Please retry.');
                    }
                } catch(error) {
                    failures.push(String(error && error.message ? error.message : error));
                    console.warn('MBOM custom: full BOM branch failed', error);
                }
            }
        }
        if(failures.length > 0) throw new Error(failures.join('\n'));
    }

    async function loadFullMBOM() {
        let elemButton = $('#load-full-mbom');
        if(elemButton.prop('disabled')) return;
        if($('#mbom-tree .item').length === 0) {
            showErrorMessage('Load full BOM', 'Wait until the Manufacturing BOM has loaded.');
            return;
        }

        elemButton.prop('disabled', true).addClass('disabled').text('Loading BOM...');
        $('#overlay').show();
        try {
            await expandFullMBOMWithBOM();
        } catch(error) {
            console.warn('MBOM custom: full BOM loading failed', error);
            showErrorMessage('Load full BOM', String(error && error.message ? error.message : error));
        } finally {
            elemButton.prop('disabled', false).removeClass('disabled').text('Load full BOM');
            updateLoadFullMBOMButtonVisibility();
            $('#overlay').hide();
        }
    }

    function updateLoadFullMBOMButtonVisibility() {
        let button = $('#load-full-mbom');
        let hasRedItems = Number($('#ebom-status').attr('data-red-item-count') || 0) > 0;
        button.toggleClass('hidden', !hasRedItems);
        button.toggle(hasRedItems);
    }

    function insertLoadFullMBOMButton() {
        if($('#load-full-mbom').length > 0) return;
        $('<button></button>')
            .attr({ id: 'load-full-mbom', type: 'button', title: 'Expand nested Manufacturing BOMs only where HAS_BOM is true' })
            .addClass('button')
            .text('Load full BOM')
            .on('click', loadFullMBOM)
            .addClass('hidden')
            .appendTo('#ebom-status');
        updateLoadFullMBOMButtonVisibility();
    }

    function insertAddRawMaterialsButton() {
        if($('#add-raw-materials').length) return;

        let button = $('<div></div>')
            .attr('id', 'add-raw-materials')
            .addClass('button default')
            .attr('title', 'Dodaj surowce znalezione na podstawie wartości pola MATERIAL w mBOM')
            .html('Dodaj surowce')
            .click(addRawMaterialsFromMBOM);

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
        if(Number(node.level) === 0) return;
        if(!isEBOMMakeItem(node, elemNode)) return;

        elemNode.addClass('ebom-make-item');

        let elemActions = elemNode.children('.item-head').children('.item-actions').first();
        if(elemActions.length === 0) return;

        // Make components must enter the manufacturing structure as MBOMs.
        // Remove the standard component insertion action.
        elemActions.children('.item-action-add')
            .not('.item-action-add-linked-mbom')
            .remove();

        let linkedMBOM = elemNode.attr('data-mbom') || getBOMLinkedFieldLink(node.mbom);
        if(!isBlank(linkedMBOM)) return;

        if(elemActions.children('.item-action-make-factory').length > 0) return;

        addActionIcon('factory', elemActions)
            .addClass('item-action-convert')
            .addClass('item-action-make-factory')
            .attr('title', 'Create a linked MBOM and add it to the selected MBOM node')
            .click(function(e) {
                e.stopPropagation();
                e.preventDefault();
                if(!validateMBOMComponentTarget()) return;

                $('#ebom').find('.item.to-convert').removeClass('to-convert');

                let elemItem = $(this).closest('.item');
                elemItem.addClass('to-convert');

                let itemName = elemItem.find('.item-head-descriptor').first().html();
                $('#convert-item-name').html(itemName);
                $('#dialog-convert').show();
                $('#overlay').show();
            });
    }

    function getHolisticDirectPartIndexes(parts, index) {
        let result = [];
        if(!Array.isArray(parts) || index < 0 || index >= parts.length) return result;

        let childLevel = Number(parts[index].level) + 1;
        for(let nextIndex = index + 1; nextIndex < parts.length; nextIndex++) {
            let nextLevel = Number(parts[nextIndex].level);
            if(nextLevel < childLevel) break;
            if(nextLevel === childLevel) result.push(nextIndex);
        }

        return result;
    }

    function getHolisticQuantity(value, fallback) {
        let quantity = parseNumericValue(value);
        if(Number.isNaN(quantity)) return (typeof fallback === 'number') ? fallback : 1;
        return quantity;
    }

    function addHolisticTotal(totals, link, quantity, partNumber) {
        let key = normalizePLMLink(link);
        if(isBlank(key)) return;

        if(!totals[key]) {
            totals[key] = {
                quantity    : 0,
                partNumbers : []
            };
        }

        totals[key].quantity += quantity;
        if(!isBlank(partNumber) && totals[key].partNumbers.indexOf(String(partNumber)) < 0) {
            totals[key].partNumbers.push(String(partNumber));
        }
    }

    function getHolisticEBOMTotals() {
        let totals = {};
        if(!Array.isArray(ebomPartsList) || ebomPartsList.length === 0) return totals;

        function visit(index, parentQuantity) {
            let part = ebomPartsList[index];
            if(!part || getBOMBooleanValue(part.ignoreInMBOM)) return;

            let quantity = (Number(part.level) === 0)
                ? parentQuantity
                : parentQuantity * getHolisticQuantity(part.quantity, 1);
            let childIndexes = getHolisticDirectPartIndexes(ebomPartsList, index).filter(function(childIndex) {
                return !getBOMBooleanValue(ebomPartsList[childIndex].ignoreInMBOM);
            });
            let isTerminal = getBOMBooleanValue(part.endItem) ||
                childIndexes.length === 0;

            if(Number(part.level) > 0 && isTerminal) {
                addHolisticTotal(totals, part.root || part.link, quantity, part.partNumber);
                return;
            }

            childIndexes.forEach(function(childIndex) {
                visit(childIndex, quantity);
            });
        }

        visit(0, 1);
        return totals;
    }

    function prepareHolisticMBOMParts(parts) {
        if(!Array.isArray(parts)) return [];

        parts.forEach(function(part) {
            prepareMBOMPartForCustomTree(part);
            part.hasChildren = getBOMPartHasChildrenCustom(part, parts);
            part.isProcess = isMBOMProcess(part);
            part.isAssemblyIndex = isAssemblyIndexNode(part);
        });

        return parts;
    }

    function fetchHolisticMBOMParts(link) {
        let normalizedLink = normalizePLMLink(link);
        if(isBlank(normalizedLink)) return Promise.resolve([]);
        if(holisticMBOMRequests[normalizedLink]) return holisticMBOMRequests[normalizedLink];

        holisticMBOMRequests[normalizedLink] = $.ajax({
            url    : '/plm/bom',
            method : 'GET',
            data   : {
                link            : getPLMItemLevelLink(link),
                viewId          : wsMBOM.viewId,
                depth           : getCustomMBOMDepth(),
                revisionBias    : 'working',
                getBOMPartsList : true
            },
            cache : false
        }).then(function(response) {
            let parts = response && response.data && Array.isArray(response.data.bomPartsList)
                ? response.data.bomPartsList
                : [];
            return prepareHolisticMBOMParts(parts);
        }).catch(function(error) {
            delete holisticMBOMRequests[normalizedLink];
            throw error;
        });

        return holisticMBOMRequests[normalizedLink];
    }

    function getHolisticMBOMPartKey(part) {
        if(!part) return '';
        let linkedEBOM = getBOMLinkedFieldLink(part.ebom);
        return part.ebomRoot || linkedEBOM || part.root || part.link || '';
    }

    function isHolisticExpandableMBOMPart(part) {
        if(!part) return false;
        if(isAssemblyIndexNode(part)) return true;
        if(isBlank(getBOMLinkedFieldLink(part.ebom))) return false;

        // A regular mBOM component can also carry an eBOM reference. The
        // standard matcher treats that as identity metadata, not as another
        // BOM boundary. Only Manufacturing items represent linked sub-mBOMs.
        let type = normalizeComparisonValue(part.type);
        return type.indexOf('manufacturing') >= 0;
    }

    async function aggregateHolisticMBOMParts(parts, rootIndex, parentQuantity, totals, expansionStack, errors) {
        let childIndexes = getHolisticDirectPartIndexes(parts, rootIndex);

        await Promise.all(childIndexes.map(async function(childIndex) {
            let part = parts[childIndex];
            let quantity = parentQuantity * getHolisticQuantity(part.quantity, 1);
            let nestedIndexes = getHolisticDirectPartIndexes(parts, childIndex);

            if(nestedIndexes.length > 0) {
                await aggregateHolisticMBOMParts(parts, childIndex, quantity, totals, expansionStack, errors);
                return;
            }

            if(part.isProcess) return;

            let expanded = false;
            if(isHolisticExpandableMBOMPart(part) && !isBlank(part.link)) {
                let expansionLink = getPLMItemLevelLink(part.link);
                let expansionKey = normalizePLMLink(expansionLink);

                if(expansionStack.has(expansionKey)) {
                    errors.push({ type : 'cycle', link : expansionLink });
                } else {
                    try {
                        let nestedParts = await fetchHolisticMBOMParts(expansionLink);
                        if(nestedParts.length > 1) {
                            let nextStack = new Set(expansionStack);
                            nextStack.add(expansionKey);
                            await aggregateHolisticMBOMParts(nestedParts, 0, quantity, totals, nextStack, errors);
                            expanded = true;
                        }
                    } catch(error) {
                        errors.push({ type : 'load', link : expansionLink, error : error });
                    }
                }
            }

            if(!expanded) {
                addHolisticTotal(totals, getHolisticMBOMPartKey(part), quantity, part.partNumber);
            }
        }));
    }

    function getRenderedDirectChildren(elemItem) {
        if(!elemItem || elemItem.length === 0) return $();
        return elemItem.children('.item-bom').first().children('.item');
    }

    function getRenderedMBOMQuantity(elemItem) {
        if(!elemItem || elemItem.length === 0 || elemItem.hasClass('root')) return 1;
        let value = elemItem.children('.item-head').find('.item-qty-input').first().val();
        return getHolisticQuantity(value, 1);
    }

    function getRenderedMBOMTotalQuantity(elemItem) {
        if(!elemItem || elemItem.length === 0) return 0;

        let quantity = getRenderedMBOMQuantity(elemItem);
        elemItem.parents('.item').each(function() {
            let elemParent = $(this);
            if(!elemParent.hasClass('root')) {
                quantity *= getRenderedMBOMQuantity(elemParent);
            }
        });

        return quantity;
    }

    function getRenderedMBOMKey(elemItem) {
        if(!elemItem || elemItem.length === 0) return '';
        let ebomRoot = elemItem.attr('data-ebom-root');
        if(!isBlank(ebomRoot)) return ebomRoot;

        let linkedEBOM = elemItem.attr('data-ebom') || elemItem.attr('data-link-ebom') || '';
        let normalizedLinkedEBOM = normalizePLMLink(linkedEBOM);

        if(!isBlank(normalizedLinkedEBOM) && Array.isArray(ebomPartsList)) {
            for(let ebomPart of ebomPartsList) {
                if(normalizePLMLink(ebomPart.link) === normalizedLinkedEBOM ||
                    normalizePLMLink(ebomPart.root) === normalizedLinkedEBOM) {
                    return ebomPart.root || ebomPart.link;
                }
            }
        }

        return linkedEBOM || elemItem.attr('data-root') || elemItem.attr('data-link') || '';
    }

    async function aggregateRenderedMBOMItem(elemItem, parentQuantity, totals, expansionStack, errors) {
        let quantity = parentQuantity * getRenderedMBOMQuantity(elemItem);
        let elemChildren = getRenderedDirectChildren(elemItem);

        if(elemChildren.length > 0) {
            for(let child of elemChildren.get()) {
                await aggregateRenderedMBOMItem($(child), quantity, totals, expansionStack, errors);
            }
            return;
        }

        if(elemItem.hasClass('process')) return;

        let expanded = false;
        if(hasMBOMShortcut(elemItem)) {
            let expansionLink = getInlineSubMBOMLink(elemItem, null);
            let expansionKey = normalizePLMLink(expansionLink);

            if(expansionStack.has(expansionKey)) {
                errors.push({ type : 'cycle', link : expansionLink });
            } else if(!isBlank(expansionKey)) {
                try {
                    let nestedParts = await fetchHolisticMBOMParts(expansionLink);
                    if(nestedParts.length > 1) {
                        let nextStack = new Set(expansionStack);
                        nextStack.add(expansionKey);
                        await aggregateHolisticMBOMParts(nestedParts, 0, quantity, totals, nextStack, errors);
                        expanded = true;
                    }
                } catch(error) {
                    errors.push({ type : 'load', link : expansionLink, error : error });
                }
            }
        }

        if(!expanded) {
            addHolisticTotal(
                totals,
                getRenderedMBOMKey(elemItem),
                quantity,
                elemItem.attr('data-part-number')
            );
        }
    }

    async function getHolisticMBOMTotals(errors) {
        let totals = {};
        let elemRoot = $('#mbom-tree').children('.item').first();
        if(elemRoot.length === 0) return totals;

        let rootLink = elemRoot.attr('data-link') || ((typeof links !== 'undefined') ? links.mbom : '');
        let expansionStack = new Set();
        if(!isBlank(rootLink)) expansionStack.add(normalizePLMLink(rootLink));

        let elemChildren = getRenderedDirectChildren(elemRoot);
        await Promise.all(elemChildren.get().map(function(child) {
            return aggregateRenderedMBOMItem($(child), 1, totals, expansionStack, errors);
        }));

        return totals;
    }

    function getHolisticComparisonState(expected, actual, key) {
        let expectedEntry = expected[key];
        let actualEntry = actual[key];

        if(!expectedEntry) return actualEntry ? 'additional' : '';
        if(!actualEntry) return 'additional';
        if(Math.abs(expectedEntry.quantity - actualEntry.quantity) > 0.000001) return 'different';
        return 'match';
    }

    function isRenderedEBOMTerminal(elemItem) {
        return getRenderedDirectChildren(elemItem).length === 0;
    }

    function isRenderedMBOMTerminal(elemItem) {
        return !elemItem.hasClass('root') &&
            !elemItem.hasClass('process') &&
            getRenderedDirectChildren(elemItem).length === 0 &&
            !hasMBOMShortcut(elemItem);
    }

    function setHolisticItemState(elemItem, state, markQuantity) {
        elemItem.removeClass('additional different match different-qty different-revision enable-update');
        if(isBlank(state)) return;

        elemItem.addClass(state);
        if(state === 'different' && markQuantity === true) elemItem.addClass('different-qty');
    }

    function getHolisticItemState(elemItem) {
        if(elemItem.hasClass('additional')) return 'additional';
        if(elemItem.hasClass('different')) return 'different';
        if(elemItem.hasClass('match')) return 'match';
        return '';
    }

    function getHolisticRollupState(elemItem) {
        let states = [];

        getRenderedDirectChildren(elemItem).each(function() {
            let state = getHolisticItemState($(this));
            if(!isBlank(state)) states.push(state);
        });

        if(states.length === 0) return '';
        if(states.indexOf('additional') >= 0) return 'additional';
        if(states.indexOf('different') >= 0) return 'different';
        return 'match';
    }

    function applyHolisticTreeRollups(selector) {
        $(selector).find('.item').get().reverse().forEach(function(item) {
            let elemItem = $(item);
            let state = getHolisticRollupState(elemItem);
            if(!isBlank(state)) setHolisticItemState(elemItem, state);
        });
    }

    function getRenderedEBOMStateByKey(key) {
        let normalizedKey = normalizePLMLink(key);
        let state = '';
        if(isBlank(normalizedKey)) return state;

        $('#ebom').find('.item').each(function() {
            let elemItem = $(this);
            let candidateKey = normalizePLMLink(elemItem.attr('data-root') || elemItem.attr('data-link'));
            if(candidateKey === normalizedKey) {
                state = getHolisticItemState(elemItem);
                return false;
            }
        });

        return state;
    }

    function applyImmediateStandardStatusRollups() {
        applyHolisticTreeRollups('#ebom');

        $('#mbom').find('.item').each(function() {
            let elemItem = $(this);
            if(elemItem.hasClass('root') || elemItem.hasClass('process')) return;
            if(!hasMBOMShortcut(elemItem) && getRenderedDirectChildren(elemItem).length === 0) return;

            let state = getRenderedEBOMStateByKey(getRenderedMBOMKey(elemItem));
            if(!isBlank(state)) setHolisticItemState(elemItem, state);
        });

        applyHolisticTreeRollups('#mbom');
    }

    function refreshCustomStatusSummary() {
        let counts = { additional : 0, different : 0, match : 0 };
        let modelStates = new Map();
        let priority = { match : 1, different : 2, additional : 3 };

        function includeItem(elemItem, state) {
            if(!Object.prototype.hasOwnProperty.call(counts, state)) return;
            counts[state]++;

            let partNumber = elemItem.attr('data-part-number');
            if(isBlank(partNumber)) return;
            let previous = modelStates.get(partNumber);
            if(!previous || priority[state] > priority[previous]) modelStates.set(partNumber, state);
        }

        // Count component rows after linked-MBOM mirroring and parent rollups.
        // Structural parents repeat their children's state and are not extras.
        $('#ebom').find('.item').each(function() {
            let elemItem = $(this);
            if(elemItem.hasClass('root') || elemItem.hasClass('item-has-bom') ||
                elemItem.hasClass('linked-mbom-check-pending') ||
                getRenderedDirectChildren(elemItem).length > 0) return;
            includeItem(elemItem, getHolisticItemState(elemItem));
        });

        $('#mbom').find('.item.is-ebom-item').each(function() {
            let elemItem = $(this);
            if(elemItem.hasClass('mbom-only') || !isRenderedMBOMTerminal(elemItem)) return;
            if(getHolisticItemState(elemItem) === 'additional') includeItem(elemItem, 'additional');
        });

        $('#ebom-status').attr('data-red-item-count', counts.additional);
        updateLoadFullMBOMButtonVisibility();

        ['additional', 'different', 'match'].forEach(function(state) {
            $('#status-' + state)
                .css('flex', counts[state] + ' 1 0%')
                .css('border-width', counts[state] === 0 ? '0px' : '5px');
        });

        if(typeof isViewerStarted === 'function' && isViewerStarted()) {
            viewerResetColors();
            if(viewerStatusColors) {
                let modelColors = { additional : colors.vectors.red, different : colors.vectors.yellow, match : colors.vectors.green };
                ['additional', 'different', 'match'].forEach(function(state) {
                    let partNumbers = [];
                    modelStates.forEach(function(modelState, partNumber) {
                        if(modelState === state) partNumbers.push(partNumber);
                    });
                    viewerSetColors(partNumbers, { keepHidden : true, unhide : false, resetColors : false, color : modelColors[state] });
                });
            }
        }

        if($('.bar.selected').length > 0 && typeof setStatusBarFilter === 'function') setStatusBarFilter();
    }

    function applyHolisticStatus(expected, actual, errors) {
        let allKeys = new Set(Object.keys(expected).concat(Object.keys(actual)));
        let counts = { additional : 0, different : 0, match : 0 };
        let viewerParts = { additional : [], different : [], match : [] };

        $('.item')
            .removeClass('additional different match different-qty different-revision enable-update');

        allKeys.forEach(function(key) {
            let state = getHolisticComparisonState(expected, actual, key);
            if(isBlank(state)) return;
            counts[state]++;

            let entry = expected[key] || actual[key];
            entry.partNumbers.forEach(function(partNumber) {
                if(viewerParts[state].indexOf(partNumber) < 0) viewerParts[state].push(partNumber);
            });
        });

        $('#ebom').find('.item').each(function() {
            let elemItem = $(this);
            if(!isRenderedEBOMTerminal(elemItem)) return;

            let key = normalizePLMLink(elemItem.attr('data-root') || elemItem.attr('data-link'));
            let state = getHolisticComparisonState(expected, actual, key);
            setHolisticItemState(elemItem, state, true);
        });

        applyHolisticTreeRollups('#ebom');

        $('#mbom').find('.item').each(function() {
            let elemItem = $(this);

            let key = normalizePLMLink(getRenderedMBOMKey(elemItem));
            let state = '';

            if(isRenderedMBOMTerminal(elemItem)) {
                state = getHolisticComparisonState(expected, actual, key);
            } else if(!elemItem.hasClass('process')) {
                state = getRenderedEBOMStateByKey(key);
            }

            setHolisticItemState(elemItem, state, isRenderedMBOMTerminal(elemItem));
        });

        applyHolisticTreeRollups('#mbom');
        refreshMissingLinkedMBOMStatus();

        ['additional', 'different', 'match'].forEach(function(state) {
            let elemBar = $('#status-' + state);
            elemBar.css('flex', counts[state] + ' 1 0%');
            elemBar.css('border-width', counts[state] === 0 ? '0px' : '5px');
        });

        let validationTitle = errors.length === 0
            ? 'Holistic comparison across the complete eBOM and all linked mBOMs'
            : 'Holistic comparison incomplete: ' + errors.length + ' linked mBOM structure(s) could not be validated';
        $('#ebom-qty-comparison').attr('title', validationTitle);

        if(typeof isViewerStarted === 'function' && isViewerStarted()) {
            viewerResetColors();
            if(viewerStatusColors) {
                viewerSetColors(viewerParts.additional, { keepHidden : true, unhide : false, resetColors : false, color : colors.vectors.red });
                viewerSetColors(viewerParts.different , { keepHidden : true, unhide : false, resetColors : false, color : colors.vectors.yellow });
                viewerSetColors(viewerParts.match     , { keepHidden : true, unhide : false, resetColors : false, color : colors.vectors.green });
            }
        }

        updateMBOMNumbers();

        if($('.bar.selected').length > 0 && typeof setStatusBarFilter === 'function') {
            setStatusBarFilter();
        }
    }

    async function refreshHolisticStatus(runId) {
        let errors = [];
        let expected = getHolisticEBOMTotals();
        let actual = await getHolisticMBOMTotals(errors);

        if(runId !== holisticStatusRun) return;
        applyHolisticStatus(expected, actual, errors);
    }

    function scheduleHolisticStatusRefresh() {
        holisticStatusRun++;
        let runId = holisticStatusRun;

        if(holisticStatusTimer !== null) clearTimeout(holisticStatusTimer);
        holisticStatusTimer = setTimeout(function() {
            holisticStatusTimer = null;
            refreshHolisticStatus(runId).catch(function(error) {
                console.warn('MBOM custom: holistic status comparison failed', error);
            });
        }, 25);
    }

    function addRawMaterialsSearchToAddItems() {
        if(typeof config === 'undefined' || !config) return;

        let searches = Array.isArray(config.predefinedSearchesInAddItems)
            ? config.predefinedSearchesInAddItems
            : [];
        let query = 'ITEM_DETAILS:TYPE%3D' + encodeURIComponent(rawMaterialTypeName);
        let exists = searches.some(function(search) {
            return search && (
                normalizeComparisonValue(search.title) === 'surowce' ||
                normalizeComparisonValue(search.query) === normalizeComparisonValue(query)
            );
        });

        if(!exists) searches.push({ title : 'Surowce', query : query });
        config.predefinedSearchesInAddItems = searches;
    }

    $(document).ready(function() {
        insertAddRawMaterialsButton();
        insertLoadFullMBOMButton();
        insertAddLeafMBOMsAndMaterialsButton();
        insertAddAssemblyIndexButton();
        setupAddProcessPicker();
        setupCustomEBOMItemFocus();
        insertERPTab();
        attachERPTabEvents();
        attachCustomModeResizeEvents();
    });

    if(typeof setStatusBar === 'function') {
        let originalSetStatusBar = setStatusBar;
        setStatusBar = function() {
            let result = originalSetStatusBar.apply(this, arguments);
            mirrorStandardStatusToLinkedEBOMRows();
            applyImmediateStandardStatusRollups();
            refreshMissingLinkedMBOMStatus();
            refreshCustomStatusSummary();
            return result;
        };
    }

    if(typeof insertSearchFilters === 'function') {
        let originalInsertSearchFilters = insertSearchFilters;
        insertSearchFilters = function() {
            addRawMaterialsSearchToAddItems();
            return originalInsertSearchFilters.apply(this, arguments);
        };
    }

    if(typeof insertFromEBOMToMBOM === 'function') {
        let originalInsertFromEBOMToMBOM = insertFromEBOMToMBOM;
        insertFromEBOMToMBOM = function(elemAction) {
            if(!validateMBOMComponentTarget()) return false;

            let source = elemAction.closest('.item');
            let linkedMBOM = getLinkedMBOMLinkFromEBOMElement(source);
            let result = !isBlank(linkedMBOM)
                ? insertLinkedMBOMWithoutEBOMChildren(elemAction, originalInsertFromEBOMToMBOM)
                : originalInsertFromEBOMToMBOM.apply(this, arguments);
            refreshNewLinkedMBOMControls();
            return result;
        };
    }

    if(typeof setBOMTotalQuantities === 'function') {
        setBOMTotalQuantities = function(linkRoot) {
            let normalizedRoot = normalizePLMLink(linkRoot);
            let quantityEBOM = 0;
            let quantityMBOM = 0;

            $('body').addClass('with-quantity-comparison');

            $('#ebom').find('.item').each(function() {
                let elemItem = $(this);
                let itemKey = normalizePLMLink(elemItem.attr('data-root') || elemItem.attr('data-link'));
                if(itemKey !== normalizedRoot) return;

                let totalQuantity = parseNumericValue(elemItem.attr('data-total-qty'));
                if(Number.isNaN(totalQuantity)) {
                    totalQuantity = getHolisticQuantity(elemItem.attr('data-qty'), 1);
                }
                quantityEBOM = totalQuantity;
            });

            $('#mbom').find('.item').each(function() {
                let elemItem = $(this);
                if(elemItem.hasClass('root') || elemItem.hasClass('process')) return;

                let itemKey = normalizePLMLink(getRenderedMBOMKey(elemItem));
                if(itemKey === normalizedRoot) {
                    quantityMBOM += getRenderedMBOMTotalQuantity(elemItem);
                }
            });

            if(Math.abs(quantityMBOM - quantityEBOM) <= 0.000001) {
                $('#ebom-qty-comparison').html('Total quantity matches in EBOM and MBOM : ' + quantityMBOM);
            } else if(quantityMBOM < quantityEBOM) {
                $('#ebom-qty-comparison').html((quantityEBOM - quantityMBOM) + ' units less in MBOM : (M) ' + quantityMBOM + ' < ' + quantityEBOM + ' (E)');
            } else {
                $('#ebom-qty-comparison').html((quantityMBOM - quantityEBOM) + ' units more in MBOM : (M) ' + quantityMBOM + ' > ' + quantityEBOM + ' (E)');
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

    if(typeof isEBOMLeaf === 'function') {
        let originalIsEBOMLeaf = isEBOMLeaf;
        isEBOMLeaf = function(node) {
            if(!node || typeof node !== 'object') {
                return originalIsEBOMLeaf.apply(this, arguments);
            }
            if(node.level === 0) return false;
            if(node.endItem) return true;

            // A linked mBOM is metadata on the engineering component, not a
            // reason to replace or truncate its eBOM branch.
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
            let elemItem = elemParent.closest('.item');

            // Linked mBOM information is used by the holistic comparison, but
            // the eBOM tree should only contain engineering navigation.
            if(elemItem.closest('#ebom').length > 0) {
                removeEBOMMBOMNavigationButtons(elemItem);
                addLinkedMBOMMarker(elemItem, getLinkedMBOMLinkFromEBOMElement(elemItem));
                return;
            }

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
                .addClass('inline-submbom-toggle')
                .addClass('icon-expand')
                .attr('title', 'Expand the linked sub-MBOM')
                .click(function(e) {

                    e.preventDefault();
                    e.stopPropagation();

                    let elemItem = $(this).closest('.item');
                    expandInlineSubMBOMForElement(elemItem);

                });

            let elemBOM = elemItem.children('.item-bom').first();
            let hasRenderedChildren = elemBOM.children('.item').length > 0;
            let isExpanded = elemBOM.length > 0 &&
                !elemBOM.hasClass('hidden') &&
                (elemItem.attr('data-inline-submbom-loaded') === 'true' || hasRenderedChildren);
            setInlineSubMBOMToggleState(elemItem, isExpanded);
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
                removeEBOMMBOMNavigationButtons(elemNode);

                let linkedMBOM = getBOMLinkedFieldLink(resolvedNode ? resolvedNode.mbom : '');
                if(!isBlank(linkedMBOM)) addLinkedMBOMMarker(elemNode, linkedMBOM);
            }

            if(bomType === 'mbom' && resolvedNode && Number(resolvedNode.level) !== 0 && !getBOMBooleanValue(resolvedNode.isEBOMItem)) {
                elemNode.addClass('mbom-only');
                elemNode.children('.item-head').children('.item-head-status').first()
                    .attr('title', 'Blue: MBOM-only item (not present in EBOM)');
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

            if(bomType === 'mbom') {
                enableSubMBOMOperationTarget(elemNode);
                attachCustomMBOMItemSelection(elemNode);
                attachCustomMBOMDropGuard(elemNode);
            }

            decorateMBOMQuantityWithUnit(elemNode, resolvedNode, bomType);
            return elemNode;
        };
    }

    if(typeof insertAdditionalItem === 'function') {
        insertAdditionalItem = function(elemHead, link, options) {
            let knownLeaf = !!(options && options.knownLeaf);
            let providedDetails = options && options.detailsData ? options.detailsData : null;
            console.log('MBOM custom: insertAdditionalItem started', {
                link      : link,
                knownLeaf : knownLeaf
            });

            $('#overlay').show();

            let detailsRequest = providedDetails
                ? Promise.resolve({ data : providedDetails })
                : $.get('/plm/details', { link : link });
            let requests = [detailsRequest];
            if(!knownLeaf) {
                requests.push($.get('/plm/bom', {
                    link         : link,
                    viewId       : wsMBOM.viewId,
                    depth        : getCustomMBOMDepth(),
                    revisionBias : config.revisionBias
                }));
            }

            return Promise.all(requests).then(function(responses) {

                let isProcess = getSectionFieldValue(responses[0].data.sections, config.workspaceMBOM.fieldIDs.isProcess, false);
                let insertedNode = $();

                $('#overlay').hide();

                if(isProcess == 'true') {
                    if(knownLeaf) {
                        throw new Error('Surowiec został nieoczekiwanie rozpoznany jako element procesu.');
                    }

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
                if(!knownLeaf) markRawMaterialStructureDirty();
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

    if(typeof setSaveActions === 'function') {
        let originalSetSaveActions = setSaveActions;
        setSaveActions = function() {
            originalSetSaveActions.apply(this, arguments);
            rawMaterialStructuralSavePending = !!(
                (Array.isArray(pendingActions) && (pendingActions[0] > 0 || pendingActions[2] > 0)) ||
                (Array.isArray(pendingRemovals) && pendingRemovals.length > 0)
            );
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

                return Promise.all(requests).then(function(responses) {
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

                    return Promise.all(requests).then(function(responses) {

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

                        return addBOMItems();

                    });
                
                }).catch(function(error) {
                    console.error('MBOM custom: BOM addition or saved-row lookup failed', error);
                    showErrorMessage('Error while adding BOM items', 'Could not complete the BOM save. Some rows may already have been saved. Reload the BOM to check its saved state before retrying.');
                    endProcessing();
                });

            } else {

                $('#step-bar3').css('width', '100%');
                $('#step3').removeClass('in-work');
                $('#step4').addClass('in-work');
                $('#step-counter3').html(pendingActions[2] + ' of ' + pendingActions[2]);

                return updateBOMItems();
            }
        };
    }

    function getMBOMChangeOrderWorkspaceId() {
        if(typeof common === 'undefined' || !common.workspaceIds) return '';
        return common.workspaceIds.changeOrders || '';
    }

    function getMBOMTechnologyItemNumber(elemItem) {
        let itemNumber = elemItem.attr('data-part-number') || elemItem.attr('data-number-db')
            || elemItem.attr('data-number') || '';
        let descriptor = elemItem.find('.item-head-descriptor').first().text().trim();
        return isBlank(itemNumber) ? descriptor.split(' - ')[0].trim() : String(itemNumber).trim();
    }

    function getSavedMBOMItems() {
        let items = [];
        let seen = {};

        $('#mbom .item').each(function() {
            let elemItem = $(this);
            if(!isMBOMTechnologyItem(elemItem)) return;

            let link = getPLMItemLevelLink(getMBOMSaveLink(elemItem));
            let key = normalizePLMLink(link);
            if(isBlank(link) || isBlank(key) || seen[key]) return;

            seen[key] = true;
            items.push({
                link       : link,
                itemNumber : getMBOMTechnologyItemNumber(elemItem)
            });
        });

        return items;
    }

    function getSavedMBOMItemLinks() {
        return getSavedMBOMItems().map(function(item) { return item.link; });
    }

    function getCurrentMBOMItemNumber() {
        let elemRoot = $('#mbom-tree').children('.item').first();
        return getMBOMTechnologyItemNumber(elemRoot);
    }

    function getMBOMChangeOrderTitle(itemNumber) {
        return 'Release WF for ' + (isBlank(itemNumber) ? getCurrentMBOMItemNumber() : itemNumber);
    }

    function getMBOMChangeOrderFieldId(field) {
        let reference = field ? (field.__self__ || field.link || field.urn || '') : '';
        return String(reference).split(/[\/:.]/).pop();
    }

    function findMBOMChangeOrderField(fields, fieldId, fieldName) {
        let normalizedName = normalizeComparisonValue(fieldName);
        return fields.find(function(field) {
            return getMBOMChangeOrderFieldId(field) === fieldId
                || normalizeComparisonValue(field && (field.name || field.title || field.displayName)) === normalizedName;
        });
    }

    function resolveMBOMChangeOrderPicklistValue(field, requestedTitle) {
        let picklist = field ? (field.picklist || field.lookups) : '';
        let picklistLink = (picklist && typeof picklist === 'object')
            ? (picklist.link || picklist.__self__ || '')
            : picklist;

        if(isBlank(picklistLink)) {
            return Promise.reject(new Error('Pole szablonu zmiany nie ma zdefiniowanej listy wyboru.'));
        }

        let offset = 0;
        function loadPage() {
            return $.get('/plm/picklist', {
                link     : picklistLink,
                limit    : 250,
                offset   : offset,
                useCache : true
            }).then(function(response) {
                let items = response && response.data && Array.isArray(response.data.items)
                    ? response.data.items : [];
                let option = items.find(function(item) {
                    return normalizeComparisonValue(item && (item.title || item.label || item.value))
                        === normalizeComparisonValue(requestedTitle);
                });

                if(option) {
                    let optionLink = option.link || option.__self__;
                    if(isBlank(optionLink)) throw new Error('Szablon zmiany Fast Track nie zwrócił odnośnika do opcji.');
                    return { link : optionLink };
                }
                if(items.length < 250) {
                    throw new Error('Nie znaleziono opcji Fast Track na liście szablonów zmian.');
                }

                offset += items.length;
                return loadPage();
            });
        }

        return loadPage();
    }

    let mbomChangeOrderStateByLink = {};

    function getMBOMChangeOrderProcessState(process) {
        let workflowState = process && process['workflow-state'] ? process['workflow-state'] : null;
        let state = workflowState && (workflowState.title || workflowState.name)
            ? (workflowState.title || workflowState.name)
            : (process && process.item ? process.item.currentState : '');
        if(state && typeof state === 'object') state = state.title || state.name || state.link || state.__self__ || '';
        return String(state || '');
    }

    function rememberMBOMChangeOrderState(process) {
        let link = process && process.item ? getPLMItemLevelLink(process.item.link) : '';
        if(!isBlank(link)) mbomChangeOrderStateByLink[normalizePLMLink(link)] = getMBOMChangeOrderProcessState(process);
    }

    function findExistingMBOMChangeOrder(rootLink, workspaceId, expectedTitle) {
        return $.get('/plm/changes', { link : rootLink, useCache : false }).then(function(response) {
            if(!response || response.error || !Array.isArray(response.data)) {
                throw new Error('Nie udało się wczytać zleceń zmian powiązanych z głównym mBOM.');
            }

            let workspaceSegment = '/workspaces/' + String(workspaceId) + '/';
            let matches = response.data.filter(function(process) {
                let itemLink = process && process.item ? process.item.link : '';
                let workflowState = process && process['workflow-state'] ? process['workflow-state'].title : '';
                let itemState = process && process.item ? process.item.currentState : '';
                let state = normalizeComparisonValue(workflowState || itemState);
                return String(itemLink).indexOf(workspaceSegment) >= 0 && state.indexOf('cancel') < 0;
            });

            matches.sort(function(left, right) {
                let leftHistory = left && left['last-workflow-history'];
                let rightHistory = right && right['last-workflow-history'];
                let leftDate = leftHistory && leftHistory.created ? leftHistory.created : '';
                let rightDate = rightHistory && rightHistory.created ? rightHistory.created : '';
                return String(rightDate).localeCompare(String(leftDate));
            });
            matches.forEach(rememberMBOMChangeOrderState);

            if(matches.length === 0 || isBlank(expectedTitle)) {
                return matches.length > 0 ? getPLMItemLevelLink(matches[0].item.link) : '';
            }

            return mapPLMRequestsWithConcurrency(matches, 5, function(process) {
                let processLink = getPLMItemLevelLink(process.item.link);
                return loadMBOMPropertyRepairDetails(processLink, 'change order').then(function(details) {
                    let title = getSectionFieldValue(details.sections || [], 'TITLE', details.title || '');
                    let normalizedTitle = normalizeComparisonValue(title);
                    let normalizedExpected = normalizeComparisonValue(expectedTitle);
                    return normalizedTitle === normalizedExpected || normalizedTitle.indexOf(normalizedExpected) >= 0
                        ? processLink : '';
                });
            }).then(function(links) {
                return links.find(function(link) { return !isBlank(link); }) || '';
            });
        });
    }

    function findActiveMBOMChangeOrders(itemLink, workspaceId, excludedLink) {
        return $.get('/plm/changes', { link : itemLink, useCache : false }).then(function(response) {
            if(!response || response.error || !Array.isArray(response.data)) {
                throw new Error('Could not load active change orders for affected-item transfer.');
            }

            let workspaceSegment = '/workspaces/' + String(workspaceId) + '/';
            let excludedKey = normalizePLMLink(excludedLink);
            let seen = {};
            let links = [];

            response.data.forEach(function(process) {
                let processLink = process && process.item ? getPLMItemLevelLink(process.item.link) : '';
                let processKey = normalizePLMLink(processLink);
                let state = normalizeComparisonValue(getMBOMChangeOrderProcessState(process));
                if(isBlank(processLink) || String(processLink).indexOf(workspaceSegment) < 0) return;
                if(state.indexOf('cancel') >= 0 || processKey === excludedKey || seen[processKey]) return;

                rememberMBOMChangeOrderState(process);
                seen[processKey] = true;
                links.push(processLink);
            });

            return links;
        });
    }

    function createMBOMChangeOrder(workspaceId, itemNumber) {
        let requiredFieldLabels = [];

        return Promise.all([
            $.get('/plm/sections', { wsId : workspaceId, useCache : true }),
            $.get('/plm/fields', { wsId : workspaceId, useCache : true })
        ]).then(function(responses) {
            if(responses.some(function(response) {
                return !response || response.error || !Array.isArray(response.data);
            })) {
                throw new Error('Nie udało się wczytać definicji obszaru roboczego zleceń zmian.');
            }

            requiredFieldLabels = responses[1].data.filter(function(field) {
                let validators = field ? (field.validations || field.fieldValidators || []) : [];
                return validators.some(function(validator) {
                    return validator.validatorName === 'required' || validator.validatorName === 'dropDownSelection';
                });
            }).map(function(field) {
                return field.name || field.title || field.displayName || field.urn || 'Unknown field';
            });

            let workspaceFields = responses[1].data;
            let titleField = findMBOMChangeOrderField(workspaceFields, 'TITLE', 'Title');
            let descriptionField = findMBOMChangeOrderField(workspaceFields, 'DESCRIPTION', 'Description');
            let templateField = findMBOMChangeOrderField(workspaceFields, 'CHANGE_TEMPLATE', 'Change Template');

            if(!titleField || !descriptionField || !templateField) {
                throw new Error('Nie udało się odnaleźć pól Tytuł, Opis i Szablon zmiany w obszarze zleceń zmian.');
            }

            return resolveMBOMChangeOrderPicklistValue(templateField, 'Fast Track').then(function(templateValue) {
                let fields = [{
                    fieldId : getMBOMChangeOrderFieldId(titleField),
                    value   : getMBOMChangeOrderTitle(itemNumber)
                }, {
                    fieldId : getMBOMChangeOrderFieldId(descriptionField),
                    value   : 'Zlecenie zmian utworzone w edytorze mBOM'
                }, {
                    fieldId : getMBOMChangeOrderFieldId(templateField),
                    value   : templateValue
                }];

                return $.post({
                    url         : '/plm/create',
                    contentType : 'application/json',
                    data        : JSON.stringify({
                        wsId       : workspaceId,
                        sections   : responses[0].data,
                        fields     : fields
                    })
                });
            });
        }).then(function(response) {
            if(!response || response.error) {
                let message = getRawMaterialErrorMessage(response);
                if(requiredFieldLabels.length > 0) {
                    message += ' Wymagane pola obszaru zleceń zmian: ' + requiredFieldLabels.join(', ') + '.';
                }
                throw new Error(message);
            }

            let link = response.data && response.data.__self__ ? response.data.__self__ : response.data;
            link = getPLMItemLevelLink(link);
            if(isBlank(link)) throw new Error('Nowe zlecenie zmian nie zwróciło odnośnika do elementu.');

            return link;
        });
    }

    function addMBOMAffectedItems(changeOrderLink, mbomLinks) {
        if(mbomLinks.length === 0) return Promise.resolve({ changeOrderLink : changeOrderLink, added : 0 });

        return $.post('/plm/add-managed-items', {
            link  : changeOrderLink,
            items : mbomLinks
        }).then(function(response) {
            if(!response || response.error) {
                throw new Error(getRawMaterialErrorMessage(response));
            }
            return { changeOrderLink : changeOrderLink, added : mbomLinks.length };
        });
    }

    function addMissingMBOMAffectedItems(changeOrderLink, mbomLinks) {
        return $.get('/plm/manages', { link : changeOrderLink, useCache : false }).then(function(response) {
            if(!response || response.error || !Array.isArray(response.data)) {
                throw new Error('Nie udało się wczytać pozycji objętych zleceniem zmian.');
            }

            let affected = {};
            response.data.forEach(function(entry) {
                let link = entry && entry.item ? entry.item.link : '';
                let key = normalizePLMLink(getPLMItemLevelLink(link));
                if(!isBlank(key)) affected[key] = true;
            });

            let missing = mbomLinks.filter(function(link) {
                return !affected[normalizePLMLink(link)];
            });

            return addMBOMAffectedItems(changeOrderLink, missing);
        });
    }

    function loadMBOMChangeOrderAffectedItemLinks() {
        let rootItem = $('#mbom-tree').children('.item').first();
        let rootLink = getPLMItemLevelLink(
            (typeof links !== 'undefined' && links && !isBlank(links.mbom))
                ? links.mbom
                : getMBOMSaveLink(rootItem)
        );
        if(isBlank(rootLink)) {
            return Promise.reject(new Error('Nie znaleziono zapisanego mBOM.'));
        }

        return getRawMaterialsBOMView().then(function(view) {
            return $.get('/plm/bom', {
                link            : rootLink,
                viewId          : view.id,
                depth           : getCustomMBOMDepth(),
                revisionBias    : 'working',
                getBOMPartsList : true
            });
        }).then(function(response) {
            let parts = response && response.data && Array.isArray(response.data.bomPartsList)
                ? response.data.bomPartsList
                : [];
            if(parts.length === 0) {
                throw new Error('Widok BOM „' + rawMaterialsBOMViewName + '” nie zwrócił żadnych elementów.');
            }

            let fieldIds = config.workspaceMBOM.fieldIDs || {};
            let seen = {};
            let affectedLinks = [rootLink];
            seen[normalizePLMLink(rootLink)] = true;

            parts.forEach(function(part) {
                let type = normalizeComparisonValue(
                    getMBOMAccountingFieldValue(part, fieldIds.type || 'TYPE')
                );
                if(type !== 'manufacturing' && type !== normalizeComparisonValue(rawMaterialTypeName)) return;

                let link = getPLMItemLevelLink(getPartItemLink(part));
                let key = normalizePLMLink(link);
                if(isBlank(link) || isBlank(key) || seen[key]) return;
                seen[key] = true;
                affectedLinks.push(link);
            });

            return affectedLinks;
        });
    }

    function performMBOMChangeOrderTransition(changeOrderLink, transitionId, comment) {
        return $.get('/plm/transitions', { link : changeOrderLink }).then(function(response) {
            if(!response || response.error || !Array.isArray(response.data)) {
                throw new Error('Nie udało się wczytać dostępnych przejść zlecenia zmian.');
            }

            let transition = response.data.find(function(action) {
                let actionLink = action ? (action.__self__ || action.link || '') : '';
                return String(actionLink).split('/').pop() === String(transitionId);
            });
            if(!transition) {
                throw new Error('Przejście ' + transitionId + ' nie jest dostępne dla bieżącego zlecenia zmian.');
            }

            return $.post('/plm/transition', {
                link       : changeOrderLink,
                transition : transition.__self__ || transition.link,
                comment    : comment
            }).then(function(transitionResponse) {
                if(!transitionResponse || transitionResponse.error) {
                    throw new Error(getRawMaterialErrorMessage(transitionResponse));
                }
                return transitionResponse;
            });
        });
    }


    function getMBOMERPRelevantAdminSectionId(sections) {
        let adminSection = null;
        for(let section of sections || []) {
            let fields = Array.isArray(section.fields) ? section.fields : [];
            let containsERPRelevant = fields.some(function(field) {
                return getMBOMChangeOrderFieldId(field) === customERPFieldIDs.relevant;
            });
            if(containsERPRelevant) return getMBOMChangeOrderFieldId(section);

            let title = section && (section.title || section.name || section.displayName);
            if(normalizeComparisonValue(title) === 'admin') adminSection = section;
        }
        return adminSection ? getMBOMChangeOrderFieldId(adminSection) : '';
    }

    function setMBOMChangeOrderERPRelevant(changeOrderLink) {
        return $.get('/plm/sections', { link : changeOrderLink, useCache : true }).then(function(response) {
            if(!response || response.error || !Array.isArray(response.data)) {
                throw new Error('Nie udało się wczytać sekcji workspace zlecenia zmian.');
            }

            let sectionId = getMBOMERPRelevantAdminSectionId(response.data);
            if(isBlank(sectionId)) throw new Error('Nie znaleziono sekcji Admin zawierającej ERP_RELEVANT w workspace zlecenia zmian.');

            return $.post('/plm/edit', {
                link     : changeOrderLink,
                sections : response.data,
                fields   : [{ fieldId : customERPFieldIDs.relevant, sectionId : sectionId, value : true }]
            }).then(function(updateResponse) {
                if(!updateResponse || updateResponse.error) {
                    throw new Error('Nie udało się ustawić pola ERP_RELEVANT na zleceniu zmian. ' + getRawMaterialErrorMessage(updateResponse));
                }
                return updateResponse;
            });
        });
    }

    function getMBOMLifecycleTitle(value) {
        if(isBlank(value)) return '';
        if(typeof value === 'string') return value;
        return value.title || value.name || value.value || '';
    }

    function getMBOMAffectedItemLifecycleState(entry) {
        let item = entry && entry.item ? entry.item : {};
        let candidates = [
            entry && entry.currentState,
            entry && entry.lifecycle,
            entry && entry.lifecycleState,
            item.currentState,
            item.lifecycle,
            item.lifecycleState
        ];

        for(let candidate of candidates) {
            let title = getMBOMLifecycleTitle(candidate);
            if(!isBlank(title)) return String(title);
        }

        return '';
    }

    function getMBOMTargetLifecycleTransitionName(currentState) {
        let normalizedState = normalizeComparisonValue(currentState);
        if(normalizedState === 'working' || normalizedState === 'unreleased') return 'To Production';
        if(normalizedState === 'production') return 'Production Revision';
        return '';
    }

    function loadMBOMAffectedItemLifecycleState(entry) {
        let currentState = getMBOMAffectedItemLifecycleState(entry);
        if(!isBlank(currentState)) return Promise.resolve(currentState);

        let itemLink = entry && entry.item ? getPLMItemLevelLink(entry.item.link) : '';
        if(isBlank(itemLink)) return Promise.resolve('');

        return $.get('/plm/details', { link : itemLink, useCache : false }).then(function(response) {
            if(!response || response.error || !response.data) {
                throw new Error('Nie udało się odczytać cyklu życia pozycji „' + itemLink + '”.');
            }
            return getMBOMAffectedItemLifecycleState(response.data);
        });
    }

    function loadMBOMWorkspaceLifecycleTransitions(itemLink, cache) {
        let workspaceId = String(itemLink || '').split('/')[4] || '';
        if(isBlank(workspaceId)) return Promise.reject(new Error('Nie udało się ustalić obszaru roboczego pozycji „' + itemLink + '”.'));
        if(cache[workspaceId]) return cache[workspaceId];

        cache[workspaceId] = $.get('/plm/workspace-lifecycle-transitions', {
            link     : itemLink,
            useCache : true
        }).then(function(response) {
            if(!response || response.error || !Array.isArray(response.data)) {
                throw new Error('Nie udało się wczytać przejść cyklu życia dla obszaru roboczego ' + workspaceId + '.');
            }
            return response.data;
        });

        return cache[workspaceId];
    }

    function setMBOMAffectedItemLifecycleTransitions(changeOrderLink) {
        return $.get('/plm/manages', { link : changeOrderLink, useCache : false }).then(function(response) {
            if(!response || response.error || !Array.isArray(response.data)) {
                throw new Error('Nie udało się wczytać pozycji objętych zleceniem zmian.');
            }
            if(response.data.length === 0) {
                throw new Error('Zlecenie zmian nie zawiera żadnych pozycji objętych zmianą.');
            }

            let transitionCache = {};
            return mapPLMRequestsWithConcurrency(response.data, 5, function(entry) {
                let affectedItemLink = entry ? (entry.__self__ || entry.link || '') : '';
                let itemLink = entry && entry.item ? getPLMItemLevelLink(entry.item.link) : '';
                let itemTitle = entry && entry.item ? (entry.item.title || itemLink) : itemLink;

                if(isBlank(affectedItemLink) || isBlank(itemLink)) {
                    throw new Error('Pozycja objęta zmianą nie zawiera prawidłowego odnośnika.');
                }

                return loadMBOMAffectedItemLifecycleState(entry).then(function(currentState) {
                    let targetName = getMBOMTargetLifecycleTransitionName(currentState);
                    if(isBlank(targetName)) {
                        throw new Error('Nieobsługiwany cykl życia „' + (currentState || 'brak wartości') + '” dla pozycji „' + itemTitle + '”.');
                    }

                    return loadMBOMWorkspaceLifecycleTransitions(itemLink, transitionCache).then(function(transitions) {
                        let targetNormalized = normalizeComparisonValue(targetName);
                        let stateNormalized = normalizeComparisonValue(currentState);
                        let matching = transitions.filter(function(transition) {
                            return normalizeComparisonValue(getMBOMLifecycleTitle(transition && (transition.name || transition.title))) === targetNormalized;
                        });
                        let transition = matching.find(function(candidate) {
                            let fromState = getMBOMLifecycleTitle(candidate && candidate.fromState);
                            return isBlank(fromState) || normalizeComparisonValue(fromState) === stateNormalized;
                        }) || matching[0];

                        if(!transition) {
                            throw new Error('Nie znaleziono przejścia „' + targetName + '” dla pozycji „' + itemTitle + '”.');
                        }

                        let transitionLink = transition.__self__ || transition.link || '';
                        let existingLink = entry.targetTransition ? (entry.targetTransition.link || entry.targetTransition.__self__ || '') : '';
                        let existingTitle = entry.targetTransition ? getMBOMLifecycleTitle(entry.targetTransition) : '';
                        if(isBlank(transitionLink)) {
                            throw new Error('Przejście „' + targetName + '” nie zawiera odnośnika API.');
                        }
                        if(normalizePLMLink(existingLink) === normalizePLMLink(transitionLink)
                            || normalizeComparisonValue(existingTitle) === targetNormalized) {
                            return { item : itemLink, transition : targetName, updated : false };
                        }

                        return $.post('/plm/update-managed-item', {
                            link       : affectedItemLink,
                            fields     : Array.isArray(entry.linkedFields) ? entry.linkedFields : [],
                            transition : transitionLink
                        }).then(function(updateResponse) {
                            if(!updateResponse || updateResponse.error) {
                                throw new Error('Nie udało się ustawić przejścia „' + targetName + '” dla pozycji „' + itemTitle + '”. ' + getRawMaterialErrorMessage(updateResponse));
                            }
                            return { item : itemLink, transition : targetName, updated : true };
                        });
                    });
                });
            });
        });
    }

    function getMBOMChangeOrderState(data) {
        let state = data && (data.currentState || data.workflowState || data['workflow-state']);
        if(!state && data && data.item) state = data.item.currentState;
        if(typeof state === 'string') return { id : '', title : state };
        state = state || {};
        let link = state.link || state.__self__ || '';
        return {
            id    : String(state.systemId || state.id || String(link).split('/').pop() || ''),
            title : String(state.title || state.name || '')
        };
    }

    function waitForMBOMChangeOrderReleased(changeOrderLink, onStatus) {
        let started = Date.now();
        let timeout = 240000;

        function poll() {
            return $.get('/plm/details', { link : changeOrderLink, useCache : false }).then(function(response) {
                if(!response || response.error || !response.data) {
                    throw new Error('Nie udało się odczytać statusu zlecenia zmian.');
                }

                let state = getMBOMChangeOrderState(response.data);
                if(typeof onStatus === 'function') onStatus(state);
                if(state.id === '310' || normalizeComparisonValue(state.title) === 'released') return state;
                if(Date.now() - started >= timeout) {
                    throw new Error('Przekroczono czas oczekiwania na status Released. Ostatni status: ' + (state.title || state.id || 'nieznany') + '.');
                }

                return new Promise(function(resolve) { setTimeout(resolve, 2000); }).then(poll);
            });
        }

        return poll();
    }

    function getMBOMERPWorkflowErrorComment(error) {
        let lines = ['Błąd automatycznego wysyłania technologii do Impuls.'];
        let message = error && error.message ? error.message : String(error || 'Nieznany błąd.');
        lines.push(message);
        let results = error && Array.isArray(error.erpResults) ? error.erpResults : [];
        results.filter(function(result) { return !result.success; }).forEach(function(result) {
            lines.push((result.descriptor || result.indeks || 'mBOM') + ': ' + (result.error || 'błąd wysyłki'));
        });
        return lines.join('\n').substring(0, 1900);
    }

    function continueMBOMReleaseWithERP(changeOrderLink, onProgress) {
        let pushToERPStarted = false;
        let syncResult = null;

        function report(stage, status, message, current, total) {
            if(typeof onProgress === 'function') onProgress(stage, status, message, current, total);
        }

        report('wait', 'active', 'Oczekiwanie na status Released.');
        return waitForMBOMChangeOrderReleased(changeOrderLink, function(state) {
            report('wait', 'active', 'Aktualny status: ' + (state.title || state.id || 'nieznany') + '.');
        }).then(function() {
            report('wait', 'done', 'Zlecenie zmian ma status Released.');
            report('push', 'active', 'Uruchamianie przejścia Push to ERP.');
            return performMBOMChangeOrderTransition(changeOrderLink, '569', 'Rozpoczęto wysyłanie technologii do Impuls z mBOM Editor.');
        }).then(function() {
            pushToERPStarted = true;
            report('push', 'done', 'Workflow ustawiono na Push to ERP.');
            report('erp', 'active', 'Wczytywanie zwolnionych rewizji mBOM.');
            return sendReleasedMBOMTechnologiesToERP(function(current, total, message) {
                report('erp', 'active', message, current, total);
            });
        }).then(function(result) {
            syncResult = result;
            report('erp', 'done', 'Wszystkie technologie wysłano do Impuls.', result.jobs.length, result.jobs.length);
            report('finish', 'active', 'Kończenie workflow.');
            return performMBOMChangeOrderTransition(
                changeOrderLink,
                '567',
                'Wysłano wszystkie technologie do Impuls. Liczba mBOM: ' + result.jobs.length + '.'
            );
        }).then(function() {
            report('finish', 'done', 'Workflow zakończono powodzeniem.');
            return syncResult;
        }).catch(function(error) {
            report('finish', 'error', error && error.message ? error.message : String(error));
            if(!pushToERPStarted) throw error;

            return performMBOMChangeOrderTransition(
                changeOrderLink,
                '566',
                getMBOMERPWorkflowErrorComment(error)
            ).catch(function(transitionError) {
                error.failureTransitionError = transitionError;
            }).then(function() {
                throw error;
            });
        });
    }

    function ensureMBOMReleaseProgressDialog() {
        let elemDialog = $('#dialog-mbom-release-progress');
        if(elemDialog.length > 0) return elemDialog;

        elemDialog = $('<div></div>').attr('id', 'dialog-mbom-release-progress').addClass('dialog').appendTo('body');
        $('<div></div>').addClass('dialog-header').text('Zwalnianie technologii').appendTo(elemDialog);
        let elemContent = $('<div></div>').addClass('dialog-content').appendTo(elemDialog);
        [
            ['release', 'Zwalnianie w PLM'],
            ['wait', 'Oczekiwanie na status Released'],
            ['push', 'Przejście Push to ERP'],
            ['erp', 'Wysyłanie do Impuls'],
            ['finish', 'Zakończenie procesu']
        ].forEach(function(step) {
            let elemStep = $('<div></div>').attr('data-stage', step[0]).addClass('step').appendTo(elemContent);
            $('<div></div>').addClass('step-label').text(step[1]).appendTo(elemStep);
            let elemProgress = $('<div></div>').addClass('step-progress').appendTo(elemStep);
            $('<div></div>').addClass('step-bar').appendTo(elemProgress);
            $('<div></div>').addClass('step-counter').text('Oczekiwanie').appendTo(elemStep);
        });
        $('<div></div>').attr('id', 'mbom-release-progress-log').addClass('erp-status-run').appendTo(elemContent);
        let elemFooter = $('<div></div>').addClass('dialog-footer').appendTo(elemDialog);
        $('<div></div>').attr('id', 'close-mbom-release-progress').addClass('button disabled').text('Zamknij').on('click', function() {
            if($(this).hasClass('disabled')) return;
            elemDialog.hide();
            $('#overlay').hide();
        }).appendTo(elemFooter);
        return elemDialog;
    }

    function showMBOMReleaseProgressDialog() {
        let elemDialog = ensureMBOMReleaseProgressDialog();
        elemDialog.find('.dialog-header').text('Zwalnianie technologii');
        elemDialog.find('.step').removeClass('in-work error');
        elemDialog.find('.step-bar').css('width', '0%');
        elemDialog.find('.step-counter').text('Oczekiwanie');
        $('#mbom-release-progress-log').empty();
        $('#close-mbom-release-progress').addClass('disabled').removeClass('default');
        $('#overlay').show();
        elemDialog.show();
        updateMBOMReleaseProgress('release', 'active', 'Przygotowywanie zlecenia zmian i przejścia 1215.');
    }

    function updateMBOMReleaseProgress(stage, status, message, current, total) {
        let elemDialog = ensureMBOMReleaseProgressDialog();
        let elemStep = elemDialog.find('.step[data-stage="' + stage + '"]');
        if(status === 'active') {
            elemDialog.find('.step').removeClass('in-work');
            elemStep.addClass('in-work');
            let counter = !isBlank(total) ? String(current || 0) + ' z ' + String(total) : 'W toku';
            elemStep.find('.step-counter').text(counter);
            if(!isBlank(total) && Number(total) > 0) elemStep.find('.step-bar').css('width', Math.min(100, Number(current || 0) * 100 / Number(total)) + '%');
        } else if(status === 'done') {
            elemStep.removeClass('in-work error').find('.step-bar').css('width', '100%');
            elemStep.find('.step-counter').text('Gotowe');
        } else if(status === 'error') {
            elemDialog.find('.step').removeClass('in-work');
            elemStep.addClass('error').find('.step-counter').text('Błąd');
        }

        if(!isBlank(message)) $('<div></div>').addClass('erp-status-line' + (status === 'error' ? ' error' : '')).text(message).appendTo($('#mbom-release-progress-log'));
    }

    function completeMBOMReleaseProgress(error) {
        let elemDialog = ensureMBOMReleaseProgressDialog();
        elemDialog.find('.dialog-header').text(error ? 'Zwalnianie technologii nie powiodło się' : 'Zwalnianie technologii zakończone');
        $('#close-mbom-release-progress').removeClass('disabled').addClass('default');
    }
    function createMBOMChangeOrderFromEditor(startReleaseTransition) {
        let workspaceId = getMBOMChangeOrderWorkspaceId();
        let mbomItems = getSavedMBOMItems();
        let rootItem = mbomItems[0];

        if(isBlank(workspaceId)) {
            return Promise.reject(new Error('Nie skonfigurowano obszaru roboczego zleceń zmian.'));
        }
        if(!rootItem || isBlank(rootItem.link)) {
            return Promise.reject(new Error('Najpierw zapisz mBOM.'));
        }
        if($('#mbom .pending, #mbom .pending-update, #mbom .pending-removal').length > 0) {
            return Promise.reject(new Error('Najpierw zapisz wszystkie zmiany w mBOM.'));
        }

        let created = false;
        let changeOrderLink = '';
        return findExistingMBOMChangeOrder(rootItem.link, workspaceId, '').then(function(existingLink) {
            if(!isBlank(existingLink)) return existingLink;
            created = true;
            return createMBOMChangeOrder(workspaceId, rootItem.itemNumber);
        }).then(function(resolvedLink) {
            changeOrderLink = resolvedLink;
            let prepareRoot = created
                ? addMBOMAffectedItems(changeOrderLink, [rootItem.link])
                : Promise.resolve();

            return prepareRoot.then(function() {
                return moveMBOMsToReleaseInOrder(mbomItems.slice(1), changeOrderLink, workspaceId);
            }).then(function() {
                return loadMBOMChangeOrderAffectedItemLinks();
            });
        }).then(function(affectedLinks) {
            return addMissingMBOMAffectedItems(changeOrderLink, affectedLinks);
        }).then(function(addResult) {
            return setMBOMAffectedItemLifecycleTransitions(changeOrderLink).then(function(lifecycleResult) {
                if(!startReleaseTransition) {
                    return { release : changeOrderLink, created : created, add : addResult, lifecycle : lifecycleResult, transitioned : false };
                }
                return setMBOMChangeOrderERPRelevant(changeOrderLink).then(function() {
                    return performMBOMChangeOrderTransition(
                        changeOrderLink,
                        '1215',
                        'Zwolnione w mBOM Editor'
                    );
                }).then(function() {
                    return { release : changeOrderLink, created : created, add : addResult, lifecycle : lifecycleResult, erpRelevant : true, transitioned : true };
                });
            });
        });
    }

    function showMBOMChangeOrderResult(title, message) {
        let elemDialog = $('#dialog-mbom-change-order-result');
        if(elemDialog.length === 0) {
            elemDialog = $('<div></div>')
                .attr('id', 'dialog-mbom-change-order-result')
                .addClass('dialog')
                .append('<div class="dialog-header"></div>')
                .append('<div class="dialog-content"></div>')
                .append('<div class="dialog-footer"><div class="button default">Zamknij</div></div>')
                .appendTo('body');
            elemDialog.find('.dialog-footer .button').on('click', function() {
                elemDialog.hide();
                $('#overlay').hide();
            });
        }

        elemDialog.find('.dialog-header').text(title);
        elemDialog.find('.dialog-content').text(message);
        $('#overlay').show();
        elemDialog.show();
    }

    function runMBOMChangeOrderAction(startReleaseTransition) {
        let approvalLabel = 'Uruchom proces zatwierdzania';
        let releaseLabel = 'Zwolnij Technologie (Technolog)';
        let elemButtons = $('#start-mbom-approval, #release-mbom-technology');
        if(elemButtons.hasClass('disabled')) return;

        elemButtons.addClass('disabled');
        $(startReleaseTransition ? '#release-mbom-technology' : '#start-mbom-approval').text('Przetwarzanie…');
        if(startReleaseTransition) showMBOMReleaseProgressDialog();
        else $('#overlay').show();

        createMBOMChangeOrderFromEditor(startReleaseTransition).then(function(result) {
            if(startReleaseTransition) {
                updateMBOMReleaseProgress('release', 'done', 'Zwolnienie w PLM zostało uruchomione przejściem 1215.');
                return continueMBOMReleaseWithERP(result.release, updateMBOMReleaseProgress).then(function(syncResult) {
                    renderERPTechnologySyncResults('Wysyłanie technologii do Impuls zakończone', syncResult.results, false, false);
                    completeMBOMReleaseProgress(false);
                    return result;
                });
            }

            let message = result.created
                ? 'Zlecenie zmian zostało utworzone.'
                : 'Użyto istniejącego aktywnego zlecenia zmian.';
            showMBOMChangeOrderResult('Proces zatwierdzania', message);
        }).catch(function(error) {
            if(startReleaseTransition) {
                let message = String(error && error.message ? error.message : error);
                updateMBOMReleaseProgress('finish', 'error', message);
                if(error && error.failureTransitionError) {
                    updateMBOMReleaseProgress('finish', 'error', 'Nie udało się również uruchomić przejścia błędu 566: ' + String(error.failureTransitionError.message || error.failureTransitionError));
                }
                if(error && Array.isArray(error.erpResults)) {
                    renderERPTechnologySyncResults('Wysyłanie technologii do Impuls nie powiodło się', error.erpResults, true, false);
                }
                completeMBOMReleaseProgress(true);
            } else {
                $('#overlay').hide();
                showErrorMessage('Proces zatwierdzania', String(error && error.message ? error.message : error));
            }
        }).finally(function() {
            elemButtons.removeClass('disabled');
            $('#start-mbom-approval').text(approvalLabel);
            $('#release-mbom-technology').text(releaseLabel);
        });
    }

    function insertMBOMChangeOrderButtons() {
        if($('#start-mbom-approval').length > 0 || $('#header-toolbar').length === 0) return;

        let elemTarget = $('#add-raw-materials').length > 0 ? $('#add-raw-materials') : $('#header-avatar');
        $('<div></div>')
            .attr('id', 'start-mbom-approval')
            .addClass('button')
            .attr('title', 'Utwórz zlecenie zmian i dodaj elementy mBOM jako pozycje objęte zmianą')
            .text('Uruchom proces zatwierdzania')
            .on('click', function() { runMBOMChangeOrderAction(false); })
            .insertBefore(elemTarget);

        $('<div></div>')
            .attr('id', 'release-mbom-technology')
            .addClass('button default')
            .attr('title', 'Utwórz zlecenie zmian i uruchom przejście zwalniające technologię')
            .text('Zwolnij Technologie (Technolog)')
            .on('click', function() { runMBOMChangeOrderAction(true); })
            .insertBefore(elemTarget);
    }

    function getMBOMReleaseAffectedItemLinks(changeOrderLink) {
        return $.get('/plm/manages', { link : changeOrderLink, useCache : false }).then(function(response) {
            if(!response || response.error || !Array.isArray(response.data)) {
                throw new Error('Could not load affected items before cancelling the change order.');
            }

            let seen = {};
            return response.data.map(function(entry) {
                return entry && entry.item ? getPLMItemLevelLink(entry.item.link) : '';
            }).filter(function(link) {
                let key = normalizePLMLink(link);
                if(isBlank(link) || isBlank(key) || seen[key]) return false;
                seen[key] = true;
                return true;
            });
        });
    }

    function getMBOMMotherItems(rootLink) {
        return $.get('/plm/where-used', {
            link     : rootLink,
            depth    : 1,
            useCache : false
        }).then(function(response) {
            let data = response && response.data ? response.data : null;
            if(!response || response.error || !data || !Array.isArray(data.edges) || !Array.isArray(data.nodes)) {
                throw new Error('Could not load where-used data for the root mBOM.');
            }

            let parentUrns = {};
            data.edges.forEach(function(edge) {
                if(edge && !isBlank(edge.child)) parentUrns[edge.child] = true;
            });

            let rootWorkspaceId = String(rootLink).split('/')[4];
            let candidates = data.nodes.filter(function(node) {
                let item = node && node.item ? node.item : null;
                let itemLink = item ? getPLMItemLevelLink(item.link) : '';
                return item && parentUrns[item.urn]
                    && normalizePLMLink(itemLink) !== normalizePLMLink(rootLink)
                    && String(itemLink).split('/')[4] === rootWorkspaceId;
            });

            return mapPLMRequestsWithConcurrency(candidates, 5, function(node) {
                let itemLink = getPLMItemLevelLink(node.item.link);
                return loadMBOMPropertyRepairDetails(itemLink, 'mother mBOM').then(function(details) {
                    let typeValue = getSectionFieldValue(
                        details.sections || [],
                        config.workspaceMBOM.fieldIDs.type,
                        '',
                        'object'
                    );
                    if(!isMBOMPropertyRepairManufacturingType(typeValue)) return null;

                    let itemNumber = getSectionFieldValue(
                        details.sections || [],
                        config.workspaceMBOM.fieldIDs.number,
                        ''
                    );
                    if(isBlank(itemNumber)) itemNumber = String(node.item.title || '').split(' - ')[0].trim();

                    return { link : itemLink, itemNumber : itemNumber, title : node.item.title || '' };
                });
            }).then(function(items) {
                let seen = {};
                return items.filter(function(item) {
                    let key = item ? normalizePLMLink(item.link) : '';
                    if(!item || isBlank(key) || seen[key]) return false;
                    seen[key] = true;
                    return true;
                });
            });
        });
    }

    function cancelMBOMRelease(changeOrderLink) {
        if(isBlank(changeOrderLink)) return Promise.resolve({ cancelled : false });

        let state = mbomChangeOrderStateByLink[normalizePLMLink(changeOrderLink)] || '';
        let normalizedState = String(state).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
        let transitionId = '';
        if(normalizedState === 'KONTROLA_TECHNOLOGII') transitionId = '1159';
        if(normalizedState === 'OPRACOWANIE_TECHNOLOGII') transitionId = '551';
        if(isBlank(transitionId)) {
            return Promise.reject(new Error(
                'The sub-mBOM release cannot be cancelled from state "' + (state || 'unknown') + '".'
            ));
        }

        return $.get('/plm/transitions', { link : changeOrderLink }).then(function(response) {
            if(!response || response.error || !Array.isArray(response.data)) {
                throw new Error('Could not load workflow actions for the sub-mBOM release.');
            }

            let transition = response.data.find(function(action) {
                let actionLink = action ? (action.__self__ || action.link || '') : '';
                return String(actionLink).split('/').pop().toUpperCase() === transitionId;
            });
            if(!transition) {
                throw new Error(transitionId + ' is not available for the sub-mBOM release in state "' + state + '".');
            }

            let transitionLink = transition.__self__ || transition.link;
            return $.post('/plm/transition', {
                link       : changeOrderLink,
                transition : transitionLink,
                comment    : 'Cancelled automatically because this mBOM is released through its mother mBOM.'
            }).then(function(transitionResponse) {
                if(!transitionResponse || transitionResponse.error) {
                    throw new Error(getRawMaterialErrorMessage(transitionResponse));
                }
                return { changeOrderLink : changeOrderLink, cancelled : true };
            });
        });
    }

    function getOrCreateMBOMRelease(ownerItem, workspaceId) {
        let releaseTitle = getMBOMChangeOrderTitle(ownerItem.itemNumber);
        return findExistingMBOMChangeOrder(ownerItem.link, workspaceId, releaseTitle).then(function(releaseLink) {
            if(!isBlank(releaseLink)) {
                return addMissingMBOMAffectedItems(releaseLink, [ownerItem.link]).then(function() {
                    return releaseLink;
                });
            }

            return createMBOMChangeOrder(workspaceId, ownerItem.itemNumber).then(function(createdLink) {
                return addMBOMAffectedItems(createdLink, [ownerItem.link]).then(function() {
                    return createdLink;
                });
            });
        });
    }

    function moveMBOMsToReleaseInOrder(items, targetReleaseLink, workspaceId) {
        let results = [];
        let transferredChangeOrders = {};
        return items.reduce(function(sequence, item) {
            return sequence.then(function() {
                return findActiveMBOMChangeOrders(item.link, workspaceId, targetReleaseLink);
            }).then(function(sourceReleaseLinks) {
                let linksToTransfer = [item.link];
                let cancelled = [];

                return sourceReleaseLinks.reduce(function(cancelSequence, sourceReleaseLink) {
                    let sourceKey = normalizePLMLink(sourceReleaseLink);
                    if(transferredChangeOrders[sourceKey]) return cancelSequence;

                    return cancelSequence.then(function() {
                        return getMBOMReleaseAffectedItemLinks(sourceReleaseLink);
                    }).then(function(affectedLinks) {
                        linksToTransfer = linksToTransfer.concat(affectedLinks);
                        return cancelMBOMRelease(sourceReleaseLink);
                    }).then(function(cancelResult) {
                        transferredChangeOrders[sourceKey] = true;
                        cancelled.push(cancelResult);
                    });
                }, Promise.resolve()).then(function() {
                    return addMissingMBOMAffectedItems(targetReleaseLink, linksToTransfer);
                }).then(function(addResult) {
                    results.push({ item : item, cancelled : cancelled, add : addResult });
                });
            });
        }, Promise.resolve()).then(function() {
            return results;
        });
    }

    function syncMBOMChangeOrderAfterSave() {
        let workspaceId = getMBOMChangeOrderWorkspaceId();
        let mbomItems = getSavedMBOMItems();

        if(isBlank(workspaceId)) {
            return Promise.reject(new Error('Nie skonfigurowano obszaru roboczego zleceń zmian.'));
        }
        if(mbomItems.length === 0) {
            return Promise.reject(new Error('Nie znaleziono zapisanego elementu mBOM.'));
        }

        let rootItem = mbomItems[0];

        return findExistingMBOMChangeOrder(rootItem.link, workspaceId, '').then(function(changeOrderLink) {
            if(isBlank(changeOrderLink)) {
                console.log('MBOM custom: save completed without change-order creation');
                return { release : '', owner : rootItem, skipped : true, add : { added : 0 } };
            }

            return loadMBOMChangeOrderAffectedItemLinks().then(function(affectedLinks) {
                return addMissingMBOMAffectedItems(changeOrderLink, affectedLinks);
            }).then(function(addResult) {
                let result = { release : changeOrderLink, owner : rootItem, skipped : false, add : addResult };
                console.log('MBOM custom: existing change order affected items synchronized', result);
                return result;
            });
        });
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
                let payloads = [];

                $('.pending-update').each(function() {

                    if(requests.length < maxRequests) {

                        let elemItem     = $(this);
                        let elemParent   = elemItem.parent().closest('.item');
                        let edQty        = elemItem.find('.item-qty-input').first().val();
                        let edMakeBuy    = elemItem.find('.item-make-buy').first().val();
                        let isEBOMItem   = elemItem.hasClass('is-ebom-item');
                        let linkParent   = getMBOMSaveLink(elemParent);
                        let linkChild    = getMBOMChildSaveLink(elemItem);

                        let params = { 
                            linkParent : linkParent,
                            linkChild  : linkChild,
                            edgeId     : elemItem.attr('data-edge'),
                            number     : elemItem.attr('data-number'),
                            pinned     : (isEBOMItem && config.pinEBOMItemsInMBOM),
                            quantity   : edQty,
                            fields     : []
                        };

                        if(isBlank(linkParent)) {
                            console.warn('MBOM custom: missing MBOM parent link while updating item', elemItem.attr('data-link'));
                            return;
                        }
                        if(isBlank(linkChild)) {
                            console.warn('MBOM custom: missing MBOM child link while updating item', elemItem.attr('data-link'));
                            return;
                        }

                        if(config.displayOptions.bomColumnMakeBuy &&
                            !isBlank(bomViewLinksMBOM.makeBuy) &&
                            !isBlank(edMakeBuy)) {
                            params.fields.push({ link : bomViewLinksMBOM.makeBuy, value : { link : edMakeBuy } });
                        }

                        requests.push($.post('/plm/bom-update', params));
                        elements.push(elemItem);
                        payloads.push(params);

                    }

                });

                return Promise.all(requests).then(function(responses) {

                    let index = 0;
                    let failed = false;

                    for(let response of responses) {

                        let elemItem = elements[index];
                        let payload = payloads[index++];

                        if(response.error) {
                            failed = true;
                            console.error('MBOM custom: BOM item update failed', {
                                payload  : payload,
                                response : response
                            });
                            continue;
                        }

                            elemItem.removeClass('pending-update');
                            elemItem.attr('data-qty', response.params.quantity);

                        if(typeof response.params.number !== 'undefined') {
                            elemItem.attr('data-number-db', response.params.number);
                        }
                        if(typeof response.params.linkChild !== 'undefined') {
                            elemItem.attr('data-link-db', response.params.linkChild);
                        }
                        if(config.displayOptions.bomColumnMakeBuy &&
                            Array.isArray(response.params.fields) &&
                            response.params.fields.length > 0) {
                            elemItem.attr('data-make-buy', response.params.fields[0].value.link);
                        }
                
                    }

                    if(failed) {
                        showErrorMessage('Error while updating BOM items', 'One or more BOM rows could not be saved. The rejected payload is available in the browser console.');
                        endProcessing();
                        return;
                    }

                    return updateBOMItems();

                }).catch(function(error) {
                    console.error('MBOM custom: BOM update request failed', error);
                    showErrorMessage('Error while updating BOM items', 'Could not complete the BOM save. Some rows may already have been saved. Reload the BOM to check its saved state before retrying.');
                    endProcessing();
                });

            } else {

                $('#step-bar4').css('width', '100%');
                $('#step4').removeClass('in-work');
                $('#step-counter4').html(pendingActions[3] + ' of ' + pendingActions[3]);

                if(rawMaterialStructuralSavePending) {
                    markRawMaterialStructureDirty();
                    rawMaterialStructuralSavePending = false;
                }
                refreshNewLinkedMBOMControls();
                return syncMBOMChangeOrderAfterSave().then(function() {
                    endProcessing();
                }).catch(function(error) {
                    console.error('MBOM custom: change order synchronization failed', error);
                    endProcessing();
                    showErrorMessage(
                        'Zapisano mBOM, ale aktualizacja zlecenia zmian nie powiodła się',
                        String(error && error.message ? error.message : error)
                    );
                });

            }
        };
    }

    if(typeof initEditor === 'function') {
        let originalInitEditor = initEditor;
        initEditor = function() {
            refreshMBOMHierarchyFlags();
            originalInitEditor.apply(this, arguments);
            $('#mbom .item').each(function() {
                attachCustomMBOMDropGuard($(this));
            });

            if(directAssemblyIndexEditor) {
                $('#ebom-tree').empty();
                $('#ebom').find('.processing').hide();
                $('body').addClass('assembly-index-editor');

                // The same PLM item supplies the MBOM data, but it is not an
                // EBOM counterpart and must not appear in EBOM Alignment.
                if(typeof setStatusBar === 'function') setStatusBar();
            }

            insertAddAssemblyIndexButton();
            insertMBOMChangeOrderButtons();
            setupAddProcessPicker();
            $('#confirm-raw-materials').off('click').on('click', function() {
                if($(this).hasClass('disabled')) return;
                $('#overlay').hide();
                $('#dialog-raw-materials').hide();
            });
            attachCustomSaveGuard();
            attachERPTabEvents();
            attachCustomModeResizeEvents();
        };
    } else {
        console.warn('MBOM custom: initEditor is not defined yet; custom editor hooks were not attached.');
    }

    if(typeof createMBOMRoot === 'function') {
        let originalCreateMBOMRoot = createMBOMRoot;
        createMBOMRoot = function(ebomItemDetails, callback) {
            if(isBlank(links.mbom) && hasAssemblyIndexTitle(ebomItemDetails)) {
                directAssemblyIndexEditor = true;
                links.mbom = getPLMItemLevelLink(
                    (ebomItemDetails && ebomItemDetails.__self__) || links.start || links.ebom
                );

                console.log('MBOM custom: using assembly index itself as the MBOM root', {
                    link  : links.mbom,
                    title : ebomItemDetails ? ebomItemDetails.title : ''
                });

                callback();
                return;
            }

            return originalCreateMBOMRoot.apply(this, arguments);
        };
    }

    function getMBOMWorkspaceFieldSectionId(fieldId) {
        if(isBlank(fieldId) || !wsMBOM || !Array.isArray(wsMBOM.sections)) return '';

        for(let section of wsMBOM.sections) {
            if(!section || !Array.isArray(section.fields)) continue;

            for(let field of section.fields) {
                if(!field) continue;

                let fieldLink = field.link || field.__self__ || '';
                if(String(fieldLink).split('/').pop() !== fieldId) continue;
                if(!isBlank(section.id)) return String(section.id);

                let sectionLink = section.__self__ || section.link || '';
                return String(sectionLink).split('/').pop();
            }
        }

        return '';
    }

    function loadMBOMOperationTypeValue() {
        let hasNewOperation = false;

        $('#mbom .item.process').each(function() {
            if(isBlank($(this).attr('data-link'))) {
                hasNewOperation = true;
                return false;
            }
        });

        if(!hasNewOperation || !isBlank(mbomOperationTypeValue)) {
            return Promise.resolve(mbomOperationTypeValue);
        }
        if(mbomOperationTypePromise) return mbomOperationTypePromise;

        let lookupLink = '/api/v3/lookups/CUSTOM_LOOKUP_ITEM_TYPES';
        let configuredTypeValue = (config.mbomRoot && config.mbomRoot.typeValue)
            ? String(config.mbomRoot.typeValue)
            : '';
        let optionsMarker = configuredTypeValue.indexOf('/options/');

        if(optionsMarker > 0) lookupLink = configuredTypeValue.substring(0, optionsMarker);

        mbomOperationTypePromise = $.get('/plm/picklist', {
            link     : lookupLink,
            limit    : 250,
            offset   : 0,
            useCache : false
        }).then(function(response) {
            let items = (response && response.data && Array.isArray(response.data.items))
                ? response.data.items
                : [];
            let processType = items.find(function(item) {
                return normalizeComparisonValue(item && (item.title || item.label || item.value)) === 'process';
            });
            let processTypeLink = processType
                ? (processType.link || processType.__self__ || '')
                : '';

            if(isBlank(processTypeLink)) {
                throw new Error('The Process option was not found in lookup CUSTOM_LOOKUP_ITEM_TYPES.');
            }

            mbomOperationTypeValue = processTypeLink;
            return mbomOperationTypeValue;
        }).always(function() {
            mbomOperationTypePromise = null;
        });

        return mbomOperationTypePromise;
    }

    if(typeof createNewItems === 'function') {
        let originalCreateNewItems = createNewItems;
        createNewItems = function() {
            let configuredNumberMatching = config.matchNewProcessNumber;
            let originalPost = $.post;

            // Omit NUMBER from new operation payloads. The PLM workspace
            // auto-numbering scheme assigns the final item number.
            config.matchNewProcessNumber = '';

            // The stock creator owns the operation payload. Intercept only
            // that synchronous request so TYPE can be added from this custom
            // script with the same explicit Basic section as TITLE.
            $.post = function(url, data) {
                if(url === '/plm/create' && data && Array.isArray(data.fields)) {
                    let titleFieldId = config.workspaceMBOM.fieldIDs.title;
                    let typeFieldId = config.workspaceMBOM.fieldIDs.type;
                    let basicSectionId = getMBOMWorkspaceFieldSectionId(titleFieldId);
                    let typeValue = mbomOperationTypeValue;

                    for(let field of data.fields) {
                        if(field.fieldId === titleFieldId && !isBlank(basicSectionId)) {
                            field.sectionId = basicSectionId;
                        }
                    }

                    let hasType = data.fields.some(function(field) {
                        return field.fieldId === typeFieldId;
                    });

                    if(!hasType && !isBlank(typeFieldId) && !isBlank(typeValue)) {
                        let typeField = {
                            fieldId : typeFieldId,
                            value   : { link : typeValue }
                        };

                        if(!isBlank(basicSectionId)) typeField.sectionId = basicSectionId;
                        data.fields.push(typeField);
                    }

                    console.log('MBOM custom: creating operation item', {
                        basicSectionId : basicSectionId,
                        fields         : data.fields
                    });

                    return $.ajax({
                        url: '/plm/create', method: 'POST', data: data, timeout: 60000
                    }).done(function(response) {
                        if(response && !response.error) return;
                        $('#save, #confirm-saving').removeClass('disabled');
                        $('#dialog-saving .in-work').removeClass('in-work');
                    }).fail(function(xhr, status) {
                        console.error('MBOM custom: operation creation request failed', { status: status, response: xhr.responseJSON || xhr.responseText });
                        $('#save, #confirm-saving').removeClass('disabled');
                        $('#dialog-saving .in-work').removeClass('in-work');
                        showErrorMessage('Operation creation failed',
                            (status === 'timeout' ? 'PLM did not respond within 60 seconds.' : getRawMaterialErrorMessage(xhr))
                            + ' Reload the MBOM and check whether the item was created before retrying.');
                    });
                }

                return originalPost.apply(this, arguments);
            };

            try {
                return originalCreateNewItems.apply(this, arguments);
            } finally {
                $.post = originalPost;
                config.matchNewProcessNumber = configuredNumberMatching;
            }
        };
    }

    if(typeof createMBOMForEBOM === 'function') {
        createMBOMForEBOM = async function createMBOMForEBOM(ebomItemDetails, number, callback) {
            let hasBom;
            try {
                hasBom = await getSourceEBOMHasChildren(ebomItemDetails);
            } catch(error) {
                showErrorMessage('Tworzenie mBOM', String(error.message || error));
                return;
            }

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

            for(let fieldToCopy of getMBOMPropertyRepairMappings()) {
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

            params.fields = params.fields.filter(function(field) { return field.fieldId !== 'HAS_BOM'; });
            params.fields.push({ fieldId: 'HAS_BOM', value: hasBom });

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

                    let elemConvertedEBOM = $('#ebom').find('.item.to-convert').first();
                    let preservedEBOMBranch = elemConvertedEBOM.children('.item-bom').first().detach();

                    links.mbom = createdLink;
                    storeMBOMLink(ebomItemDetails.__self__);
                    storeContextMBOMLink();
                    if(typeof callback === 'function') callback(links.mbom);

                    if(elemConvertedEBOM.length > 0 && preservedEBOMBranch.length > 0) {
                        let elemHead = elemConvertedEBOM.children('.item-head').first();
                        let elemToggle = elemHead.children('.item-toggle').first();

                        elemConvertedEBOM
                            .removeClass('leaf')
                            .addClass('item-has-bom')
                            .attr('data-mbom', createdLink)
                            .append(preservedEBOMBranch);

                        elemToggle.removeClass('icon icon-expand icon-collapse');
                        addBOMToggle(elemToggle);

                        elemHead.children('.item-actions').remove();
                        insertEBOMActions(elemHead, false);
                        removeEBOMMBOMNavigationButtons(elemConvertedEBOM);
                        addLinkedMBOMMarker(elemConvertedEBOM, createdLink);

                        setTotalQuantities();
                        setStatusBar();
                    }
                }
            });

        };
    }

})();
