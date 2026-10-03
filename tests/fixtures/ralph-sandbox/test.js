const assert = require('assert');
const { sum } = require('./src/sum');

assert.strictEqual(sum([1, 2, 3]), 6, 'sum([1,2,3]) should be 6');
assert.strictEqual(sum([]), 0, 'sum([]) should be 0');
assert.strictEqual(sum([5]), 5, 'sum([5]) should be 5');
console.log('all tests passed');
