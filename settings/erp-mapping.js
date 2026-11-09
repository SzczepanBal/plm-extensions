// Central ERP mapping used by Data Manager, Item Manager and MBOM.
// Tenant-specific deployments can replace this file while keeping application code unchanged.
module.exports = {
    version : 1,

    operations : {
        addProduct : {
            endpoint : 'add-product',
            fields : {
                index       : ['NUMBER'],
                partIndex   : ['INDEKS_CZESCI', 'NUMBER'],
                name        : ['NAZWA_DEFRO', 'TITLE', 'NUMBER'],
                description : ['OPIS'],
                group       : ['GRUPA_PRODUKTOWA'],
                unit        : ['UNIT_OF_MEASURE', 'UOM', 'UNIT', 'BOM_UOM', 'ITEM_UOM'],
                makeOrBuy   : ['MAKE_OR_BUY'],
                multiSeries : ['WIELOSERYJNOSC'],
                finishedGood: ['WYROB_GOTOWY']
            },
            defaults : {
                unit                         : 'szt',
                serialControl                : 'T',
                serialNumbers                : 'WPD',
                commercialVersionEditable    : 'T',
                finishedGoodGroupSuffix      : '_WG'
            },
            required : ['indeks', 'nazwa_czesci', 'id_grupy'],
            propertyProfiles : {
                default : [
                    { erp : 'Materiał'          , plm : ['MATERIAL'] },
                    { erp : 'Masa'              , plm : ['ITEM_WEIGHT'] },
                    { erp : 'Opis'              , plm : ['OPIS'] },
                    { erp : 'Nazwa'             , plm : ['NAZWA'] },
                    { erp : 'Tytuł'             , plm : ['TITLE'] },
                    { erp : 'Tutuł'             , plm : ['TITLE'] },
                    { erp : 'Grupa produktowa'  , plm : ['GRUPA_PRODUKTOWA'] },
                    { erp : 'Nazwa urządzenia'  , plm : ['NAZWA_URZDZENIA'] },
                    { erp : 'Typ części'         , plm : ['TYP_CZESCI'] },
                    { erp : 'Rodzaj'             , plm : ['RODZAJ'] },
                    { erp : 'Wariant'            , plm : ['WARIANT'] },
                    { erp : 'Specyfikacja'       , plm : ['SPECYFIKACJA'] },
                    { erp : 'Producent'          , plm : ['PRODUCENT'] },
                    { erp : 'Szerokość'          , plm : ['SZEROKOSC', 'WIDTH'] },
                    { erp : 'Długość'            , plm : ['DUGOSC', 'LENGTH'] },
                    { erp : 'Wysokość/grubość'   , plm : ['WYSOKOSC', 'HEIGHT'] },
                    { erp : 'Średnica'           , plm : ['SREDNICA'] },
                    { erp : 'Kolor'              , plm : ['KOLOR'] },
                    { erp : 'Powłoka'            , plm : ['POWLOKA'] },
                    { erp : 'Moc'                , plm : ['MOC'] },
                    { erp : 'Moc/Wielkość'       , plm : ['MOC_WIELKOSC', 'MOC'] },
                    { erp : 'Napięcie'           , plm : ['NAPICIE'] },
                    { erp : 'Prąd'               , plm : ['PRD'] },
                    { erp : 'Wydajność'          , plm : ['WYDAJNO'] },
                    { erp : 'Temperatura'         , plm : ['TEMPERATURA'] },
                    { erp : 'Gęstość'            , plm : ['GSTO'] },
                    { erp : 'Uwagi'              , plm : ['UWAGI'] }
                ],
                assemblyIndex : [
                    { erp : 'Opis'             , plm : ['OPIS'] },
                    { erp : 'Nazwa'            , plm : ['NAZWA'] },
                    { erp : 'Tytuł'            , plm : ['TITLE'] },
                    { erp : 'Tutuł'            , plm : ['TITLE'] },
                    { erp : 'Rewizja'          , plm : ['REVISION'] },
                    { erp : 'Materiał'         , plm : ['MATERIAL'] },
                    { erp : 'Specyfikacja'     , plm : ['SPECYFIKACJA'], defaultKey : 'specification' },
                    { erp : 'Status'            , plm : ['STATUS'] },
                    { erp : 'Grupa produktowa' , plm : ['GRUPA_PRODUKTOWA'], defaultKey : 'productGroup' },
                    { erp : 'Typ części'        , plm : ['TYP_CZESCI'], defaultKey : 'partType' },
                    { erp : 'Rodzaj'            , plm : ['RODZAJ'], defaultKey : 'kind' },
                    { erp : 'Wariant'           , plm : ['WARIANT'], defaultKey : 'variant' },
                    { erp : 'Nazwa urządzenia' , plm : ['NAZWA_URZDZENIA'], includeWhenBlank : true },
                    { erp : 'Moc/Wielkość'      , plm : ['MOC'], includeWhenBlank : true },
                    { erp : 'Uwagi'             , plm : ['UWAGI'] },
                    { erp : 'Lifecycle'         , plm : ['LIFECYCLE'] }
                ]
            }
        },

        modifyProduct : {
            extends  : 'addProduct',
            endpoint : 'modify-product',
            required : ['indeks_czesci']
        },

        addTechnology : {
            endpoint : 'add-technology',
            fields : {
                index         : ['NUMBER'],
                name          : ['NAZWA_DEFRO', 'TITLE'],
                description   : ['REVISION'],
                revision      : ['REVISION'],
                versionId     : ['ID_WERSJI'],
                technologyId  : ['ID_TECHNOLOGI'],
                operationCode : ['KOD_OPERACJI', 'KOD OPERACJI', 'OPERATION_CODE', 'OPERATION CODE', 'KODOPERACJI']
            },
            defaults : {
                approved : 'N',
                locked   : 'N'
            },
            required : ['indeks', 'nazwa_czesci'],
            properties : [
                { erp : 'Grupa Produktowa', plm : ['GRUPA_PRODUKTOWA'] },
                { erp : 'Typ czesci'       , plm : ['TYP_CZESCI'] }
            ]
        }
    }
};
