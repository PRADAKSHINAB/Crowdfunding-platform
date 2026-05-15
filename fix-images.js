const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'crowdfunding');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));

for (const file of files) {
    const filePath = path.join(dir, file);
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Replace ${campaign.image} with correct absolute path if needed
    content = content.replace(/\$\{campaign\.image\}/g, "${campaign.image.startsWith('http') ? campaign.image : API_BASE.replace('/api', '') + campaign.image}");
    
    fs.writeFileSync(filePath, content);
}
console.log('Fixed broken image links in all HTML files.');
