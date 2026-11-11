'use strict';

// A worker is busy when anything is queued on it, routed to it, or reserved for an
// in-flight upload or shared-submodel handoff. Shared by the lifecycle vacuum and
// the admin "stop worker" path so both agree on what "idle" means.
const isNodeBusy = (node, routeCount) =>
    node.getInfoProperty('taskQueueCount', 0) > 0 || routeCount > 0 || node.transients > 0;

module.exports = { isNodeBusy };
