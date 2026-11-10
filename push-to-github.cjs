const git = require('/tmp/git-helper/node_modules/isomorphic-git');
const http = require('/tmp/git-helper/node_modules/isomorphic-git/http/node');
const fs = require('fs');

const token = process.argv[2] || process.env.GITHUB_TOKEN;

if (!token || token.includes('<') || token.includes('YOUR_GITHUB_TOKEN')) {
  console.error('\n❌ ERROR: Please provide your actual GitHub Personal Access Token (PAT).');
  console.error('\nExample:');
  console.error('  node push-to-github.cjs ghp_1234567890abcdef\n');
  process.exit(1);
}

async function run() {
  console.log('Connecting to GitHub (https://github.com/steveharryy/aideployment)...');
  
  const result = await git.push({
    fs,
    http,
    dir: '/Users/abhaypandit/Documents/Orchestrator',
    remote: 'origin',
    ref: 'main',
    onAuth: () => ({ username: token.trim() })
  });

  if (result.ok) {
    console.log('\n✅ SUCCESS: Pushed successfully to https://github.com/steveharryy/aideployment (branch: main)');
  } else {
    console.error('\n❌ Push failed:', result);
  }
}

run().catch((err) => {
  console.error('\n❌ Push failed:', err.message);
  process.exit(1);
});

