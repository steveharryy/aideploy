import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverFile = path.resolve(__dirname, '../src/server.ts');

console.log('Running test suite for repo-a (Payment Service)...');

if (!fs.existsSync(serverFile)) {
  console.error('FAIL: src/server.ts does not exist');
  process.exit(1);
}

const content = fs.readFileSync(serverFile, 'utf-8');

// Test 1: PaymentServer class defined
if (!content.includes('class PaymentServer')) {
  console.error('FAIL: PaymentServer class is missing');
  process.exit(1);
}
console.log('✓ Test 1: PaymentServer class exists');

// Test 2: charge method exists
if (!content.includes('charge(')) {
  console.error('FAIL: charge method is missing');
  process.exit(1);
}
console.log('✓ Test 2: charge method exists');

// Test 3: If health check exists, verify acceptance criteria (status: UP)
if (content.includes('getHealth')) {
  if (!content.includes("status: 'UP'") && !content.includes('status: "UP"')) {
    console.error('FAIL: getHealth method does not return status: UP');
    process.exit(1);
  }
  console.log('✓ Test 3: getHealth returns status UP as specified');
} else {
  console.log('○ Test 3: getHealth not implemented yet (baseline state)');
}

console.log('\nAll tests passed successfully for repo-a!');
process.exit(0);

