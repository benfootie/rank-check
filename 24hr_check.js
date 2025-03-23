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
const RANKINGS_HISTORY_FILE = path.join(__dirname, 'rankings_history.json');

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

// Get previous rankings from approximately 24 hours ago
function getPreviousRankings(history, targetTime) {
  if (history.length === 0) {
    return null;
  }
  // Find the snapshot closest to 24 hours ago
  let closestSnapshot = history[0];
  let minDiff = Math.abs(closestSnapshot.timestamp - targetTime);
  for (const snapshot of history) {
    const diff = Math.abs(snapshot.timestamp - targetTime);
    if (diff < minDiff) {
      minDiff = diff;
      closestSnapshot = snapshot;
    }
  }
  // Use the snapshot if it’s within 1 hour of 24 hours ago
  if (minDiff <= 3600) { // 3600 seconds = 1 hour
    return closestSnapshot.rankings;
  } else {
    return null;
  }
}

// Generate dynamic image based on rank movement
async function generateImage(rank, name, floorPrice, volume, movement) {
  const canvas = createCanvas(512, 512);
  const ctx = canvas.getContext('2d');

  // Load the appropriate spiky image
  const spikyType = movement === 'up' ? 'green' : movement === 'down' ? 'red' : 'orange';
  const spikyImg = await loadImage(path.join(ASSETS_DIR, `${spikyType}_spiky.png`));
  ctx.drawImage(spikyImg, 0, 0, 512, 512);

  // Set text color based on movement
  const textColor = movement === 'up' ? 'green' : movement === 'down' ? 'red' : 'orange';
  ctx.fillStyle = textColor;
  ctx.font = '20px Arial';

  // Draw text in the black rectangle area
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

  // Load rankings history
  let history = [];
  try {
    history = JSON.parse(fs.readFileSync(RANKINGS_HISTORY_FILE, 'utf8'));
  } catch (e) {
    console.log('No rankings history found');
  }

  const now = Math.floor(Date.now() / 1000); // Current timestamp in seconds
  const targetTime = now - 24 * 3600; // 24 hours ago in seconds
  const previousRankings = getPreviousRankings(history, targetTime);

  // Process each collection
  for (let i = 0; i < 100; i++) {
    const tokenId = i + 1;
    const collection = collections[i];
    const currentRank = tokenId;
    let movement = 'same';

    // Determine movement based on rank 24 hours ago
    if (previousRankings) {
      const previousRank = previousRankings[collection.id] || 101; // 101 if not in top 100 before
      if (currentRank < previousRank) {
        movement = 'up'; // Rank improved (lower number)
      } else if (currentRank > previousRank) {
        movement = 'down'; // Rank dropped (higher number)
      }
    }

    // Extract collection details
    const name = collection.name || 'Unknown';
    const floorPrice = collection.floorAsk?.price?.amount?.decimal || 0;
    const volume = collection.volume?.['1day'] || 0;

    // Generate and save image
    const imageBuffer = await generateImage(currentRank, name, floorPrice, volume, movement);
    fs.writeFileSync(path.join(IMAGES_DIR, `token${tokenId}.png`), imageBuffer);
  }

  // Add new snapshot to history
  const newSnapshot = {
    timestamp: now,
    rankings: {}
  };
  collections.forEach((collection, index) => {
    newSnapshot.rankings[collection.id] = index + 1;
  });
  history.push(newSnapshot);

  // Prune snapshots older than 25 hours
  const cutoff = now - 25 * 3600; // 25 hours ago
  history = history.filter(snapshot => snapshot.timestamp >= cutoff);

  // Save updated history
  fs.writeFileSync(RANKINGS_HISTORY_FILE, JSON.stringify(history, null, 2));
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