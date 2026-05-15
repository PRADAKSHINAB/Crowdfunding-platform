const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'crowdfunding');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));

const localLogic = "(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'http://localhost:4000/api' : 'https://crowdfunding-platform-backend-ffke.onrender.com/api')";

for (const file of files) {
    const filePath = path.join(dir, file);
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Replace const API_BASE = '...'
    content = content.replace(
        /const\s+API_BASE\s*=\s*['"]https:\/\/crowdfunding-platform-backend-ffke\.onrender\.com\/api['"]/g,
        'const API_BASE = ' + localLogic
    );
    
    // Replace inline fetches with standard quotes
    content = content.replace(
        /fetch\(\s*['"]https:\/\/crowdfunding-platform-backend-ffke\.onrender\.com\/api\/([^'"]+)['"]/g,
        'fetch(' + localLogic + ' + "/$1"'
    );
    
    // Replace template literal fetches
    content = content.replace(
        /fetch\(\s*`https:\/\/crowdfunding-platform-backend-ffke\.onrender\.com\/api\/([^`]+)`/g,
        'fetch(' + localLogic + ' + `/$1`'
    );

    fs.writeFileSync(filePath, content);
}
console.log('Successfully replaced hardcoded Render URLs with dynamic API_BASE logic.');
