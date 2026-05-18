#!/usr/bin/env node

/**
 * Generate PNG icons from SVG for Chrome Extension
 * Usage: node scripts/generate-icons.js
 */

const fs = require('fs');
const path = require('path');

// Check if sharp is available (fast image processing)
let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  console.log('⚠️  sharp not installed. Install with: npm install --save-dev sharp');
  console.log('   Using alternative method...\n');
}

const ICON_SIZES = [16, 32, 48, 128];
const SVG_PATH = path.join(__dirname, '..', 'public', 'icon.svg');
const ICONS_DIR = path.join(__dirname, '..', 'public', 'icons');

// Create icons directory
if (!fs.existsSync(ICONS_DIR)) {
  fs.mkdirSync(ICONS_DIR, { recursive: true });
  console.log('✓ Created icons directory');
}

async function generateWithSharp() {
  console.log('🎨 Generating icons using sharp...\n');
  
  const svgBuffer = fs.readFileSync(SVG_PATH);
  
  for (const size of ICON_SIZES) {
    const outputPath = path.join(ICONS_DIR, `icon${size}.png`);
    
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outputPath);
    
    console.log(`✓ Generated icon${size}.png (${size}x${size})`);
  }
  
  console.log('\n✅ All icons generated successfully!');
}

function generateWithCanvas() {
  console.log('🎨 Generating icons using canvas...\n');
  
  // Create HTML file to generate icons
  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Generate Icons</title>
</head>
<body>
  <h2>Generating icons... Please wait.</h2>
  <div id="status"></div>
  <script>
    const sizes = [16, 32, 48, 128];
    const svg = \`${fs.readFileSync(SVG_PATH, 'utf8')}\`;
    
    async function generateIcons() {
      const status = document.getElementById('status');
      
      for (const size of sizes) {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        
        const blob = new Blob([svg], {type: 'image/svg+xml'});
        const url = URL.createObjectURL(blob);
        
        await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            ctx.drawImage(img, 0, 0, size, size);
            URL.revokeObjectURL(url);
            
            canvas.toBlob((pngBlob) => {
              const link = document.createElement('a');
              link.download = 'icon' + size + '.png';
              link.href = URL.createObjectURL(pngBlob);
              link.click();
              
              status.innerHTML += '<p>✓ Generated icon' + size + '.png</p>';
              resolve();
            });
          };
          img.src = url;
        });
      }
      
      status.innerHTML += '<h3>✅ All icons generated!</h3>';
    }
    
    generateIcons();
  </script>
</body>
</html>
  `;
  
  const htmlPath = path.join(ICONS_DIR, 'generate.html');
  fs.writeFileSync(htmlPath, htmlContent);
  
  console.log('⚠️  Canvas method requires browser interaction');
  console.log(`📂 Open this file in browser: ${htmlPath}`);
  console.log('   Icons will download automatically\n');
}

// Main execution
if (sharp) {
  generateWithSharp().catch(console.error);
} else {
  generateWithCanvas();
  console.log('\n💡 Recommendation: Install sharp for automated icon generation');
  console.log('   npm install --save-dev sharp\n');
}
