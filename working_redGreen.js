require('dotenv').config();
const express = require('express');
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL;

// Directory paths
const ASSETS_DIR = path.join(__dirname, 'assets');
const IMAGES_DIR = path.join(__dirname, 'images');
const PREVIOUS_RANKINGS_FILE = path.join(__dirname, 'previous_rankings.json');
const PREVIOUS_COLORS_FILE = path.join(__dirname, 'previous_colors.json');

// Ensure images directory exists
if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR);
}

// Fetch top 100 collections by 24-hour volume from Reservoir API
async function fetchTopCollections() {
  let collections = [];
  let continuation = null;
  const limit = 20;
  const target = 100;

  while (collections.length < target) {
    let url = `https://api-apechain.reservoir.tools/collections/v7?sortBy=1DayVolume&limit=${limit}`;
    if (continuation) url += `&continuation=${continuation}`;
    const response = await fetch(url, {
      headers: { 'x-api-key': process.env.RESERVOIR_API_KEY }
    });
    if (!response.ok) {
      console.error(`API request failed: ${response.status} ${response.statusText}`);
      break;
    }
    const data = await response.json();
    collections = collections.concat(data.collections);
    continuation = data.continuation;
    if (!continuation) break;
  }

  return collections.slice(0, target);
}

// Generate dynamic image based on color
async function generateImage(rank, name, floorPrice, volume, color) {
  const canvas = createCanvas(512, 512);
  const ctx = canvas.getContext('2d');

  // Load the appropriate spiky image based on color
  const spikyImg = await loadImage(path.join(ASSETS_DIR, `${color}_spiky.png`));
  ctx.drawImage(spikyImg, 0, 0, 512, 512);

  // Set text color
  ctx.fillStyle = color;
  ctx.font = '20px Arial';

  // Draw text
  ctx.fillText(`Rank: ${rank}`, 150, 120);
  ctx.fillText(`Name: ${name.substring(0, 20)}`, 150, 140); // Truncate long names
  ctx.fillText(`Floor: ${floorPrice.toFixed(2)} APE`, 150, 160);
  ctx.fillText(`Volume: ${volume.toFixed(2)} APE`, 150, 180);

  return canvas.toBuffer('image/png');
}

// Update rankings and generate images
async function updateRankings() {
  const collections = await fetchTopCollections();
  if (!collections.length) {
    console.error('No collections fetched');
    return;
  }

  // Load previous rankings
  let previousRankings = {};
  try {
    previousRankings = JSON.parse(fs.readFileSync(PREVIOUS_RANKINGS_FILE, 'utf8'));
  } catch (e) {
    console.log('No previous rankings found');
  }

  // Load previous colors
  let previousColors = {};
  try {
    previousColors = JSON.parse(fs.readFileSync(PREVIOUS_COLORS_FILE, 'utf8'));
  } catch (e) {
    console.log('No previous colors found');
  }

  const newPreviousRankings = {};
  const newPreviousColors = {};

  // Process each collection
  for (let i = 0; i < 100; i++) {
    const tokenId = i + 1;
    const collection = collections[i];
    const currentRank = tokenId;
    const previousRank = previousRankings[collection.id] || 101;

    // Determine rank movement
    let movement;
    if (currentRank < previousRank) {
      movement = 'up';
    } else if (currentRank > previousRank) {
      movement = 'down';
    } else {
      movement = 'same';
    }

    // Determine color
    let color;
    if (movement === 'up') {
      color = 'green';
    } else if (movement === 'down') {
      color = 'red';
    } else { // movement === 'same'
      color = previousColors[collection.id] || 'red'; // Default to red if no previous color
    }

    // Extract collection details
    const name = collection.name || 'Unknown';
    const floorPrice = collection.floorAsk?.price?.amount?.decimal || 0;
    const volume = collection.volume?.['1day'] || 0;

    // Generate and save image
    const imageBuffer = await generateImage(currentRank, name, floorPrice, volume, color);
    fs.writeFileSync(path.join(IMAGES_DIR, `token${tokenId}.png`), imageBuffer);

    // Update new previous rankings and colors
    newPreviousRankings[collection.id] = currentRank;
    newPreviousColors[collection.id] = color;
  }

  // Write to files
  fs.writeFileSync(PREVIOUS_RANKINGS_FILE, JSON.stringify(newPreviousRankings, null, 2));
  fs.writeFileSync(PREVIOUS_COLORS_FILE, JSON.stringify(newPreviousColors, null, 2));
}

// Serve NFT metadata
app.get('/metadata/:tokenId', (req, res) => {
  const tokenId = parseInt(req.params.tokenId);
  if (tokenId < 1 || tokenId > 100) {
    return res.status(404).send('Invalid token ID');
  }
  const metadata = {
    name: `Rank #${tokenId}`,
    description: `Represents the rank ${tokenId} collection`,
    image: `${SERVER_URL}/images/token${tokenId}.png`,
    attributes: [{ trait_type: 'Rank', value: tokenId }]
  };
  res.json(metadata);
});

// Serve images statically
app.use('/images', express.static(IMAGES_DIR));

// Initial update and periodic updates every 5 minutes
updateRankings();
setInterval(updateRankings, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});