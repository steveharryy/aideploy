import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexFile = path.resolve(__dirname, '../src/index.ts');

console.log('Running test suite for repo-b (Order Service)...');

if (!fs.existsSync(indexFile)) {
  console.error('FAIL: src/index.ts does not exist');
  process.exit(1);
}

const content = fs.readFileSync(indexFile, 'utf-8');

if (!content.includes('class OrderService')) {
  console.error('FAIL: OrderService class is missing');
  process.exit(1);
}
console.log('✓ Test 1: OrderService class exists');

if (!content.includes('createOrder(')) {
  console.error('FAIL: createOrder method is missing');
  process.exit(1);
}
console.log('✓ Test 2: createOrder method exists');

console.log('\nAll tests passed successfully for repo-b!');
process.exit(0);

