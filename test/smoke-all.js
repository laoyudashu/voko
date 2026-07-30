#!/usr/bin/env node

const { main } = require('../build/testing/smoke-all');

main().catch((error) => {
  console.error('冒烟测试异常:', error);
  process.exit(1);
});
