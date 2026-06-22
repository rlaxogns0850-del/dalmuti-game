function generateDalmutiDeck() {
  const deck = [];
  for (let rank = 1; rank <= 12; rank++) {
    for (let i = 0; i < rank; i++) {
      deck.push({ id: `card_${rank}_${i}`, rank, isJoker: false });
    }
  }
  for (let i = 0; i < 2; i++) {
    deck.push({ id: `joker_${i}_${Date.now()}_${i}`, rank: 13, isJoker: true });
  }
  return deck;
}

function shuffleDeck(deck) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function dealCards(playerCount) {
  const deck = shuffleDeck(generateDalmutiDeck());
  const hands = Array.from({ length: playerCount }, () => []);
  const cardsPerPlayer = Math.floor(deck.length / playerCount);
  const totalUsed = cardsPerPlayer * playerCount;

  for (let i = 0; i < totalUsed; i++) {
    hands[i % playerCount].push(deck[i]);
  }

  hands.forEach((hand) =>
    hand.sort((a, b) => {
      if (a.isJoker && !b.isJoker) return 1;
      if (!a.isJoker && b.isJoker) return -1;
      return a.rank - b.rank;
    })
  );

  return { hands, deadCards: deck.slice(totalUsed) };
}

module.exports = { generateDalmutiDeck, shuffleDeck, dealCards };
