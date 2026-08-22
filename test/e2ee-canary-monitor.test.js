'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CanaryMonitor } = require('../build/e2ee/canary-monitor');

test('monitor emits redacted reports and triggers one emergency disable on unsafe state',async()=>{
  let failures=0,plaintextFallbacks=0,disabled=0;const reports=[];
  const runtime={diagnostics(){return{enabled:disabled===0,emergencyDisabled:disabled>0,scopeCount:2,failures,plaintextFallbacks,
    received:4,replied:3,rejected:1,sessions:[],receipts:[]}},async emergencyDisable(){disabled++}};
  const monitor=new CanaryMonitor(runtime,{failureThreshold:2,onReport:r=>reports.push(r)});
  const first=await monitor.check();assert.equal(first.productionEnabled,false);assert.equal(JSON.stringify(first).includes('agent'),false);
  failures=2;await monitor.check();await monitor.check();assert.equal(disabled,1);assert.equal(reports.at(-1).emergencyDisabled,true);
  plaintextFallbacks=1;await monitor.check();assert.equal(disabled,1);monitor.stop();
});
