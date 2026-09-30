/*
 * Fusion Manage Action Script
 * Assign this script to the workspace On Edit behavior.
 * It may also be assigned to On Create so new items enter the ERP queue.
 *
 * ERP fields should be hidden from normal users or made read-only.
 */

var hash = String(item.ERP_HASH || '');
var pendingHash = /^pending:(v1:[0-9a-f]{64})$/.exec(hash);

if (pendingHash !== null) {
    item.ERP_HASH = pendingHash[1];
    item.ERP_SYNC_DATE = new Date();
    item.ERP_SYNC_STATUS = 'UP_TO_DATE';
} else {
    if (hash === '') {
        item.ERP_HASH = 'dirty:new';
        item.ERP_SYNC_STATUS = 'NOT_SYNCED';
    } else if (hash.indexOf('dirty:') !== 0) {
        item.ERP_HASH = 'dirty:' + hash;
        item.ERP_SYNC_STATUS = 'OUT_OF_DATE';
    } else if (hash === 'dirty:new') {
        item.ERP_SYNC_STATUS = 'NOT_SYNCED';
    } else {
        item.ERP_SYNC_STATUS = 'OUT_OF_DATE';
    }
}
