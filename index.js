require('dotenv').config();
const express = require('express');
const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const ASSETS_DIR = path.join(__dirname, 'assets');
const IMAGES_DIR = path.join(__dirname, 'images');
const PREVIOUS_RANKINGS_FILE = path.join(__dirname, 'previous_rankings.json');
const PREVIOUS_COLORS_FILE = path.join(__dirname, 'previous_colors.json');

if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR);
}

let latestCollections = [];

async function fetchWithRetry(url, options, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429) {
        const waitTime = delay * Math.pow(2, i);
        console.log(`Rate limited, retrying in ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      if (!response.ok) {
        console.error(`HTTP error: ${response.status} ${response.statusText}`);
        return null; // Return null instead of throwing, so app doesn't crash
      }
      return response;
    } catch (error) {
      const waitTime = delay * Math.pow(2, i);
      console.log(`Error fetching, retrying in ${waitTime}ms...`, error.message);
      if (i === retries - 1) {
        console.error('Fetch failed after retries:', error.message);
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

async function fetchTopCollections() {
  let collections = [];
  let continuation = null;
  const limit = 20; // API max limit
  const target = 100;

  while (collections.length < target) {
    let url = `https://api-apechain.reservoir.tools/collections/v7?sortBy=1dayVolume&limit=${limit}`;
    if (continuation) url += `&continuation=${continuation}`;
    
    const response = await fetchWithRetry(url, {
      headers: { 'x-api-key': process.env.RESERVOIR_API_KEY }
    });
    if (!response) {
      console.error('Failed to fetch collections batch');
      break;
    }
    
    const data = await response.json();
    if (!data.collections || data.collections.length === 0) {
      console.error('No collections returned in this batch');
      break;
    }
    collections = collections.concat(data.collections);
    continuation = data.continuation;
    if (!continuation || collections.length >= target) break;

    // Add a small delay between requests to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return collections.slice(0, target);
}

async function generateImage(rank, name, floorPrice, volume, color) {
  const canvas = createCanvas(512, 512);
  const ctx = canvas.getContext('2d');

  let spikyImg;
  try {
    spikyImg = await loadImage(path.join(ASSETS_DIR, `${color}_spiky.png`));
  } catch (error) {
    console.error(`Failed to load ${color}_spiky.png:`, error);
    return null;
  }
  if (!spikyImg) return null;

  ctx.drawImage(spikyImg, 0, 0, 512, 512);

  ctx.fillStyle = color;
  ctx.font = '20px Arial';

  ctx.fillText(`Rank: ${rank}`, 150, 120);
  ctx.fillText(`Name: ${name.substring(0, 20)}`, 150, 140);
  ctx.fillText(`Floor: ${floorPrice.toFixed(2)} APE`, 150, 160);
  ctx.fillText(`Volume: ${volume.toFixed(2)} APE`, 150, 180);

  return canvas.toBuffer('image/png');
}

async function updateRankings() {
  const collections = await fetchTopCollections();
  if (!collections || collections.length === 0) {
    console.error('No collections fetched');
    latestCollections = [];
    return;
  }
  latestCollections = collections;

  let previousRankings = {};
  try {
    previousRankings = JSON.parse(fs.readFileSync(PREVIOUS_RANKINGS_FILE, 'utf8'));
  } catch (e) {
    console.log('No previous rankings found');
  }

  let previousColors = {};
  try {
    previousColors = JSON.parse(fs.readFileSync(PREVIOUS_COLORS_FILE, 'utf8'));
  } catch (e) {
    console.log('No previous colors found');
  }

  const newPreviousRankings = {};
  const newPreviousColors = {};
  const numCollections = Math.min(collections.length, 100);

  for (let i = 0; i < numCollections; i++) {
    const tokenId = i + 1;
    const collection = collections[i];
    if (!collection || !collection.id) {
      console.error(`Invalid collection at index ${i}:`, collection);
      continue;
    }

    const currentRank = tokenId;
    const previousRank = previousRankings[collection.id] || 101;

    let movement;
    if (currentRank < previousRank) {
      movement = 'up';
    } else if (currentRank > previousRank) {
      movement = 'down';
    } else {
      movement = 'same';
    }

    let color = movement === 'up' ? 'green' : movement === 'down' ? 'red' : (previousColors[collection.id] || 'red');

    const name = collection.name || 'Unknown';
    const floorPrice = collection.floorAsk?.price?.amount?.decimal || 0;
    const volume = collection.volume?.['1day'] || 0;

    const imageBuffer = await generateImage(currentRank, name, floorPrice, volume, color);
    if (imageBuffer) {
      fs.writeFileSync(path.join(IMAGES_DIR, `token${tokenId}.png`), imageBuffer);
    }

    newPreviousRankings[collection.id] = currentRank;
    newPreviousColors[collection.id] = color;
  }

  fs.writeFileSync(PREVIOUS_RANKINGS_FILE, JSON.stringify(newPreviousRankings, null, 2));
  fs.writeFileSync(PREVIOUS_COLORS_FILE, JSON.stringify(newPreviousColors, null, 2));
}

app.get('/metadata/:tokenId', (req, res) => {
  const tokenId = parseInt(req.params.tokenId);
  if (tokenId < 1 || tokenId > latestCollections.length || !latestCollections.length) {
    return res.status(404).send('Invalid token ID or no data available');
  }
  const collection = latestCollections[tokenId - 1];
  const metadata = {
    name: `Rank #${tokenId}: ${collection.name || 'Unknown'}`,
    description: `Represents the rank ${tokenId} collection on ApeChain`,
    image: `${req.protocol}://${req.get('host')}/images/token${tokenId}.png`,
    attributes: [
      { trait_type: 'Rank', value: tokenId },
      { trait_type: 'Collection Name', value: collection.name || 'Unknown' },
      { trait_type: 'Floor Price', value: collection.floorAsk?.price?.amount?.decimal || 0 },
      { trait_type: '24h Volume', value: collection.volume?.['1day'] || 0 }
    ]
  };
  res.json(metadata);
});

app.use('/images', express.static(IMAGES_DIR));

updateRankings();
setInterval(updateRankings, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});