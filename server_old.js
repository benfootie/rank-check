require('dotenv').config();
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const fetch = require('node-fetch');
const fs = require('fs');

async function fetchTopCollections() {
  let collections = [];
  let continuation = null;
  const limit = 20;
  const target = 100;

  while (collections.length < target) {
    let url = `https://api-apechain.reservoir.tools/collections/v7?sortBy=1DayVolume&limit=${limit}`;
    if (continuation) {
      url += `&continuation=${continuation}`;
    }
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

function getRankMovement(currentRank, collectionId) {
  const previousRankings = JSON.parse(fs.readFileSync('previous_rankings.json', 'utf8'));
  const previousRank = previousRankings[collectionId] || 101; // 101 if not in top 100 before
  if (currentRank < previousRank) return 'up';
  if (currentRank > previousRank) return 'down';
  return 'same';
}

app.get('/', (req, res) => {
  res.send('NFT Server is running!');
});

app.get('/top-collections', async (req, res) => {
  try {
    const collections = await fetchTopCollections();
    res.json(collections);
  } catch (error) {
    console.error(error);
    res.status(500).send('Failed to fetch collections');
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});