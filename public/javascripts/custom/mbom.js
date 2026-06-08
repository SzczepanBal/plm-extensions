(function() {

    function customIsBlank(value) {
        return (typeof value === 'undefined' || value === null || String(value).trim() === '');
    }

    function getSiteSpecificFieldLink(sections, fieldId) {
        if(typeof getSectionFieldValue !== 'function') return '';
        return getSectionFieldValue(sections, fieldId, '', 'link');
    }

    function alignEbomAndMbomSiteLinks(itemDetails) {
        if(customIsBlank(siteSuffix)) return;
        if(typeof config === 'undefined') return;

        let fieldIdEBOM = (typeof urlParameters !== 'undefined' && !customIsBlank(urlParameters.contextfieldidebom))
            ? urlParameters.contextfieldidebom
            : config.workspaceMBOM.fieldIDs.ebom;

        let fieldIdMBOM = (typeof urlParameters !== 'undefined' && !customIsBlank(urlParameters.contextfieldidmbom))
            ? urlParameters.contextfieldidmbom
            : config.workspaceEBOM.fieldIDs.mbom;

        let ebomLink = getSiteSpecificFieldLink(itemDetails.sections, fieldIdEBOM + siteSuffix);
        let mbomLink = getSiteSpecificFieldLink(itemDetails.sections, fieldIdMBOM + siteSuffix);

        if(!customIsBlank(ebomLink)) {
            links.ebom = ebomLink;
        }

        if(!customIsBlank(mbomLink)) {
            links.mbom = mbomLink;
        }
    }

    let originalProcessItemData = window.processItemData;
    if(typeof originalProcessItemData === 'function') {
        window.processItemData = function(itemDetails) {
            alignEbomAndMbomSiteLinks(itemDetails);
            return originalProcessItemData(itemDetails);
        };
    }

})();
